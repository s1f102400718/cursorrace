'use strict';
// Cursor Run サーバー: ゲームの配信、ランキング（デイリー／固定コース）、マルチプレイ（Ultimate Chicken Horse 方式）
//   npm install && node server.js  →  http://localhost:8080/?room=abc
// マルチでのサーバーの役割: フェーズ進行、箱（ピース候補）の生成、設置の受理と検証、レースクロック、採点。
// マルチの当たり判定は各クライアントが行い、死亡/ゴールを申告する（マルチは身内で遊ぶ前提のまま）。
//
// 外に公開するときの守り（どれも環境変数で調整）:
//   配信するのは PUBLIC_FILES だけ（設計書・テスト・このファイルは出さない）。SERVE_ALL=1 で開発用に全部配信
//   HOST=127.0.0.1                    待ち受けるアドレス。トンネルやリバースプロキシを同じ機械で動かすなら、外から直接つながせない
//   TRUST_PROXY=<前段のプロキシの数>  相手の IP を X-Forwarded-For の後ろから数えて取る（PaaS の入口が 1 つなら 1）
//   TRUST_PROXY=cf                    Cloudflare（Tunnel を含む）の後ろ。CF-Connecting-IP を信じる。必ず HOST=127.0.0.1 と組にする
//                                     どちらも「外から直接はつながらない」構成でだけ設定する。直接つながると、相手が接続元を偽って回数の上限をすり抜けられる
//   ADMIN_TOKEN=<合言葉>              管理用 API（/api/admin/…）を有効にする。16 文字以上。未設定なら無効
//   FRAME_ANCESTORS=<CSP の値>        このページを枠の中に埋め込んでよい相手（既定は 'self' = 埋め込み不可）
//   VERIFY=0                          記録の検証（verify.js）を切る（開発用）
//   LIMITS=0                          回数制限を切る（負荷試験・開発用）
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { courseFor, verifyRun } = require('./verify.js');

const PORT = process.env.PORT || 8080, HOST = process.env.HOST || undefined;
const TP = String(process.env.TRUST_PROXY || '').toLowerCase(), FA = String(process.env.FRAME_ANCESTORS || '');
const ENV = { serveAll: process.env.SERVE_ALL === '1', trustCf: TP === 'cf', trustProxy: TP === 'cf' ? 0 : Math.max(0, parseInt(TP, 10) || 0), admin: process.env.ADMIN_TOKEN || '', verify: process.env.VERIFY !== '0', limits: process.env.LIMITS !== '0', frame: /^[\w\s'*:./-]{1,300}$/.test(FA) ? FA : "'self'" };
if (ENV.admin && ENV.admin.length < 16){ console.log('ADMIN_TOKEN が短すぎます（16 文字以上にしてください）。管理用 API は無効のままです'); ENV.admin = ''; }
// 回数の上限。[回数, 秒]。接続元ごと（WS のメッセージは接続ごと）。学校や会社のように1つの IP を大勢で使う回線でも足りる程度に取ってある
const LIM = { get: [900, 60], post: [40, 60], badRun: [6, 60], newPid: [40, 86400], admin401: [10, 60], wsUp: [40, 60], wsMsg: [45, 1], wsJoin: [20, 60],
  wsPerIp: 8, wsTotal: 800, wsBuffered: 1 << 20, rooms: 300, boardsInMemory: 300, ghostDays: 30, hits: 200000 };
const hits = new Map(); // 種類|相手 → { n, t }
function slot(kind, who, lim){ const k = kind + '|' + who, now = Date.now(); let b = hits.get(k); if (!b || now - b.t >= lim[1] * 1000){ if (hits.size >= LIM.hits) hits.clear(); b = { n: 0, t: now }; hits.set(k, b); } return b; }
function allow(kind, who, lim){ return !ENV.limits || ++slot(kind, who, lim).n <= lim[0]; }   // 1回ぶん数えて、上限の内か
function over(kind, who, lim){ return ENV.limits && slot(kind, who, lim).n >= lim[0]; }       // 数えずに、もう上限か
setInterval(() => { const now = Date.now(); for (const [k, b] of hits) if (now - b.t > 86400000 || (now - b.t > 120000 && !k.startsWith('newPid|'))) hits.delete(k); }, 60000).unref();
// 回数を数える単位。IPv6 は /64（1つの回線が丸ごと持っている範囲）でまとめる。そうしないと、アドレスを替えるだけで上限をやり直せる
function ipKey(a){
  a = String(a || '?').slice(0, 64); const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a); if (m4) return m4[1];
  if (!a.includes(':')) return a;
  const parts = a.split('%')[0].split('::'), hs = parts[0] ? parts[0].split(':') : [], ts = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const full = parts.length > 1 ? [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts] : hs;
  return full.slice(0, 4).map(x => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
function ipOf(req){
  if (ENV.trustCf){ const cf = req.headers['cf-connecting-ip']; if (typeof cf === 'string' && cf) return ipKey(cf); }
  if (ENV.trustProxy){ const xs = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); if (xs.length) return ipKey(xs[Math.max(0, xs.length - ENV.trustProxy)]); }
  return ipKey(req.socket.remoteAddress);
}
// 名前: 互換文字をそろえ、制御文字・見えない文字・向きを変える文字を落とし、12 文字まで。BOT は名乗れない
function cleanName(v){
  let s = String(v == null ? '' : v).slice(0, 200); try { s = s.normalize('NFKC'); } catch (e) {}
  s = [...s.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, 12).join('').trim();
  return /^bot$/i.test(s) ? '' : s;
}
const T = {
  W: 1280, H: 720, PAD_R: 46,
  BOX: 12000, PLACE: 25000, COUNT: 3000, RUN: 45000, RESULTS: 8000, FINAL: 12000,
  LATE: 5000,          // GO後これだけ待ってもスタートパッドに乗らなければ脱落
  TARGET: 15,          // この点に達したら決着
};
if (process.env.FAST) Object.assign(T, { BOX: 400, PLACE: 400, COUNT: 200, RUN: 1500, RESULTS: 200, FINAL: 200, LATE: 400 }); // 自動テスト用
const MAX_ROUNDS = Math.max(1, parseInt(process.env.MAX_ROUNDS, 10) || 30); // 誰も目標の点に届かないまま、このラウンド数で打ち切る
const START = { x: 90, y: 360 }, GOAL = { x: 1190, y: 360 };
const COLORS = ['#5ee1ff', '#ff9f43', '#b980ff', '#49e07c', '#ff5c8a', '#ffe066', '#7cf5d6', '#ffffff'];

function initialLevel(){
  return [
    { t: 'wall', x: 400, y: 0, w: 40, h: 420, owner: null, round: 0, id: 'w1' },
    { t: 'wall', x: 840, y: 300, w: 40, h: 420, owner: null, round: 0, id: 'w2' },
  ];
}
const rnd = (a, b) => a + Math.random() * (b - a);
const sign = () => Math.random() < 0.5 ? -1 : 1;
// 箱に入るピースの型。座標は設置点(0,0)からの相対。
const TEMPLATES = [
  { name: '壁 縦', make: () => ({ t: 'wall', x: -20, y: -110, w: 40, h: 220 }) },
  { name: '壁 横', make: () => ({ t: 'wall', x: -110, y: -20, w: 220, h: 40 }) },
  { name: 'スライダー 縦', make: () => ({ t: 'slider', x: -20, y: -200, w: 40, h: 140, dy: 260, period: rnd(1.6, 2.8), phase: Math.random() }) },
  { name: 'スライダー 横', make: () => ({ t: 'slider', x: -200, y: -20, w: 140, h: 40, dx: 260, period: rnd(1.6, 2.8), phase: Math.random() }) },
  { name: '回転バー', make: () => ({ t: 'bar', x: 0, y: 0, len: 300, thick: 14, rpm: sign() * rnd(18, 32), phase: Math.random() }) },
  { name: '3枚刃', make: () => ({ t: 'bar', x: 0, y: 0, len: 240, thick: 12, rpm: sign() * 30, phase: Math.random(), blades: 3 }) },
  { name: '振り子', make: () => ({ t: 'bar', x: 0, y: 0, len: 320, thick: 14, rpm: sign() * 12, phase: Math.random(), anchor: 'end' }) },
  { name: '脈動', make: () => ({ t: 'pulser', x: 0, y: 0, rmin: 16, rmax: 90, period: rnd(1.5, 2.5), phase: Math.random() }) },
  { name: '周回', make: () => ({ t: 'orbit', x: 0, y: 0, R: 100, r: 18, rpm: sign() * 40, phase: Math.random() }) },
  { name: 'レーザー 縦', make: () => ({ t: 'gate', ax: 0, ay: -100, bx: 0, by: 100, thick: 8, period: 1.4, duty: 0.5, phase: Math.random() }) },
  { name: 'レーザー 横', make: () => ({ t: 'gate', ax: -100, ay: 0, bx: 100, by: 0, thick: 8, period: 1.4, duty: 0.5, phase: Math.random() }) },
  { name: '点滅壁', make: () => ({ t: 'blink', x: -30, y: -120, w: 60, h: 240, period: 1.4, duty: 0.5, phase: Math.random() }) },
  { name: '砲台', make: () => { const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]; return { t: 'shooter', x: 0, y: 0, dx: d[0], dy: d[1], speed: 400, interval: 0.9, r: 11, range: 560, phase: Math.random() }; } },
  // --- 図鑑から採用（2026-11-06） ---
  { name: '狙い撃ち', make: () => ({ t: 'aimed', x: 0, y: 0, speed: 340, interval: rnd(0.7, 1.1), r: 6, life: 4 }) },
  { name: '回転レーザー', make: () => ({ t: 'rotlaser', x: 0, y: 0, len: 700, rpm: sign() * rnd(5, 9), thick: 10, on: 1.6, warn: 0.7, off: 1.5, phase: Math.random() }) },
  { name: '雨', make: () => ({ t: 'rain', x: -200, w: 400, interval: 0.14, speed: 300, r: 6, seed: Math.floor(Math.random() * 99) + 1 }) },
  { name: '往復レーザー', make: () => ({ t: 'slidelaser', x: 0, y: 0, len: 260, dx: 360, period: rnd(2.2, 3.4), thick: 8, phase: Math.random() }) },
  { name: '押し潰し', make: () => ({ t: 'crusher', x: -90, y: 0, w: 180, h: 400, gap: 60, travel: 130, period: rnd(1.8, 2.8), phase: Math.random() }) },
  { name: '十字スピナー', make: () => ({ t: 'bar', x: 0, y: 0, len: 360, thick: 14, rpm: sign() * rnd(12, 20), phase: Math.random(), blades: 4 }) },
  { name: '伸縮バー', make: () => ({ t: 'stretch', x: 0, y: 0, lmin: 80, lmax: 520, period: rnd(2, 3), rpm: sign() * 10, thick: 14, phase: Math.random() }) },
  { name: '地雷', make: () => ({ t: 'mine', x: 0, y: 0, trigger: 70, fuse: 0.5, blast: 90, hold: 0.3, cooldown: 2 }) },
  { name: '予告付き床', make: () => ({ t: 'warnfloor', x: -130, y: -90, w: 260, h: 180, period: rnd(2.4, 3.6), duty: 0.3, warn: 0.6, phase: Math.random() }) },
  { name: '追跡者', make: () => ({ t: 'chaser', x: 0, y: 0, speed: 170, r: 18 }) },
  { name: '自分の影', make: () => ({ t: 'shadow', x: 0, y: 0, delay: 1.5, r: 10 }) },
  // --- 2026-11-23: 画面を端から端まで貫くレーザー。照射中は画面が揺れる（揺れは見た目だけ）---
  { name: '横断レーザー', make: () => ({ t: 'beam', x: 0, y: 0, deg: [0, 90, 45, 135][Math.floor(Math.random() * 4)], thick: 84, warn: 0.8, on: 0.8, off: rnd(1.4, 2.2), phase: Math.random() }) },
  // --- 2026-11-24: 第2弾（図鑑の残り＋新案）。どれも時刻だけで動くので、位置の同期は要らない ---
  { name: 'リング弾幕', make: () => ({ t: 'danmaku', x: 0, y: 0, pattern: 'ring', n: 16, speed: 150, interval: rnd(0.8, 1.1), r: 6, spin: sign() * rnd(5, 9), life: 2.2, phase: Math.random() }) },
  { name: '渦巻き', make: () => ({ t: 'danmaku', x: 0, y: 0, pattern: 'ring', n: 3, speed: 170, interval: 0.08, r: 5, spin: sign() * 11, life: 1.8, phase: Math.random() }) },
  { name: '扇の掃射', make: () => ({ t: 'danmaku', x: 0, y: 0, pattern: 'fan', n: 5, spread: 40, aim: Math.floor(Math.random() * 360), speed: 240, interval: 0.3, r: 6, spin: sign() * 6, life: 1.6, phase: Math.random() }) },
  { name: '炸裂弾', make: () => ({ t: 'burst', x: 0, y: 0, aim: Math.floor(Math.random() * 360), spin: 47, interval: 1.2, speed: 140, fuse: 1.0, m: 10, speed2: 160, life2: 1.2, r: 9, r2: 5 }) },
  { name: '反射弾', make: () => ({ t: 'bounce', x: 0, y: 0, n: 5, speed: 200, interval: 2.2, r: 7, life: 4, spin: 20, box: [190, 20, 1090, 700] }) },
  { name: '跳ねるボール', make: () => { const a = (Math.floor(Math.random() * 4) * 90 + rnd(25, 65)) * Math.PI / 180; return { t: 'ball', x: 0, y: 0, vx: Math.round(Math.cos(a) * 280), vy: Math.round(Math.sin(a) * 280), r: 28, box: [190, 20, 1090, 700] }; } },
  { name: '巡回ブロック', make: () => ({ t: 'patrol', pts: [[-150, -100], [150, -100], [150, 100], [-150, 100]], speed: sign() * rnd(260, 360), w: 54, h: 54, phase: Math.random() }) },
  { name: '列車', make: () => ({ t: 'train', x: 0, y: 0, R: 130, cars: 5, size: 38, rpm: sign() * rnd(20, 28), spacing: 20, phase: Math.random() }) },
  { name: '蛇', make: () => ({ t: 'serpent', vert: true, x: 0, y: 0, amp: 80, wave: 360, speed: sign() * rnd(220, 300), segs: 13, gap: 24, r: 14 }) },
  { name: '呼吸ブロック', make: () => ({ t: 'breathe', x: 0, y: 0, w: 200, h: 320, period: rnd(1.8, 2.6), min: 0.15, phase: Math.random() }) },
  { name: 'レーザー順送り', make: () => ({ t: 'seq', x: -160, y: -200, w: 320, h: 400, lines: 4, slot: 0.35, on: 0.28, thick: 10, phase: Math.random() }) },
  { name: '回る輪', make: () => ({ t: 'ringwall', x: 0, y: 0, R: 130, thick: 16, n: 2, gap: 60, rpm: sign() * rnd(14, 22), phase: Math.random() }) },
  { name: '速度制限区画', sizable: true, make: () => ({ t: 'speedzone', x: 0, y: 0, w: 240, h: 180, limit: 400 }) },
  { name: '停止禁止区画', sizable: true, make: () => ({ t: 'nostop', x: 0, y: 0, w: 240, h: 180, min: 150, grace: 0.5 }) },
];

// ---- 設置の検証（クライアント側にも同じものがある） ----
function bounds(p){
  switch (p.t){
    case 'wall': case 'blink': return { x: p.x, y: p.y, w: p.w, h: p.h };
    case 'slider': return { x: p.x + Math.min(0, p.dx || 0), y: p.y + Math.min(0, p.dy || 0), w: p.w + Math.abs(p.dx || 0), h: p.h + Math.abs(p.dy || 0) };
    case 'bar': { const r = (p.anchor === 'end' ? p.len : p.len / 2) + p.thick / 2; return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }; }
    case 'pulser': return { x: p.x - p.rmax, y: p.y - p.rmax, w: 2 * p.rmax, h: 2 * p.rmax };
    case 'orbit': { const r = p.R + p.r; return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }; }
    case 'gate': { const r = p.thick / 2; return { x: Math.min(p.ax, p.bx) - r, y: Math.min(p.ay, p.by) - r, w: Math.abs(p.ax - p.bx) + 2 * r, h: Math.abs(p.ay - p.by) + 2 * r }; }
    case 'shooter': { const ex = p.x + p.dx * p.range, ey = p.y + p.dy * p.range, r = p.r; return { x: Math.min(p.x, ex) - r, y: Math.min(p.y, ey) - r, w: Math.abs(ex - p.x) + 2 * r, h: Math.abs(ey - p.y) + 2 * r }; }
    // 図鑑採用分。回転レーザー/狙い撃ち/影は本体(ハブ)だけを占有扱いにする（効果範囲は広くてよい）
    case 'rotlaser': case 'aimed': case 'shadow': case 'beam': case 'danmaku': case 'bounce': case 'burst': return { x: p.x - 20, y: p.y - 20, w: 40, h: 40 };
    // 第2弾（index.html の bounds と同じ）
    case 'patrol': { const xs = p.pts.map(q => q[0]), ys = p.pts.map(q => q[1]), x = Math.min(...xs) - p.w / 2, y = Math.min(...ys) - p.h / 2; return { x, y, w: Math.max(...xs) + p.w / 2 - x, h: Math.max(...ys) + p.h / 2 - y }; }
    case 'breathe': return { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
    case 'ball': return { x: p.x - p.r, y: p.y - p.r, w: 2 * p.r, h: 2 * p.r };
    case 'train': case 'ringwall': { const r = p.R + (p.t === 'train' ? p.size * 0.71 : p.thick / 2); return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }; }
    case 'serpent': return p.vert ? { x: p.x - p.amp - p.r, y: 0, w: 2 * (p.amp + p.r), h: T.H } : { x: 0, y: p.y - p.amp - p.r, w: T.W, h: 2 * (p.amp + p.r) };
    case 'seq': return { x: p.x - p.thick / 2, y: p.y - p.thick / 2, w: p.w + p.thick, h: p.h + p.thick };
    case 'rain': return { x: p.x, y: 0, w: p.w, h: T.H };
    case 'slidelaser': return { x: p.x - p.dx / 2 - p.thick, y: p.y - p.len / 2, w: p.dx + 2 * p.thick, h: p.len };
    case 'crusher': return { x: p.x, y: p.y - p.h / 2, w: p.w, h: p.h };
    case 'stretch': { const r = p.lmax / 2 + p.thick / 2; return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }; }
    case 'mine': return { x: p.x - p.blast, y: p.y - p.blast, w: 2 * p.blast, h: 2 * p.blast };
    case 'warnfloor': case 'speedzone': case 'nostop': return { x: p.x, y: p.y, w: p.w, h: p.h };
    case 'chaser': return { x: p.x - p.r, y: p.y - p.r, w: 2 * p.r, h: 2 * p.r };
  }
  return { x: p.x, y: p.y, w: 0, h: 0 };
}
const SIZABLE = new Set(['speedzone', 'nostop']);
function translate(p, cx, cy){ const q = { ...p }; if (p.t === 'gate'){ q.ax += cx; q.bx += cx; q.ay += cy; q.by += cy; } else if (p.t === 'patrol') q.pts = p.pts.map(a => [a[0] + cx, a[1] + cy]); else { q.x += cx; q.y += cy; } return q; }
function rectCircleClear(b, c, r){ const dx = Math.max(b.x - c.x, 0, c.x - (b.x + b.w)), dy = Math.max(b.y - c.y, 0, c.y - (b.y + b.h)); return Math.hypot(dx, dy) > r; }
// 設置結果のピースを作る。範囲指定(sizable)は {x,y,w,h} の矩形、それ以外は中心座標 (cx,cy)
function materialize(rel, m){
  if (SIZABLE.has(rel.t)){
    const w = Math.round(+m.w), h = Math.round(+m.h), x = Math.round(+m.x), y = Math.round(+m.y);
    if (![w, h, x, y].every(Number.isFinite) || w < 80 || h < 80) return null;
    return { ...rel, x, y, w, h };
  }
  const cx = Math.round(+m.x), cy = Math.round(+m.y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0 || cx > T.W || cy > T.H) return null;
  return translate(rel, cx, cy);
}
function placementOk(p){
  const b = bounds(p), mustFit = ['wall', 'blink', 'slider', 'gate', 'crusher', 'slidelaser', 'warnfloor', 'speedzone', 'nostop', 'rain', 'patrol', 'breathe', 'seq'].includes(p.t);
  if (mustFit && (b.x < 0 || b.y < 0 || b.x + b.w > T.W || b.y + b.h > T.H)) return false;
  if (p.t === 'beam' && (beamNear(p, START, T.PAD_R + 10) || beamNear(p, GOAL, T.PAD_R + 10))) return false; // パッドを貫く置き方は不可
  return rectCircleClear(b, START, T.PAD_R + 10) && rectCircleClear(b, GOAL, T.PAD_R + 10);
}
function beamNear(p, c, r){ const a = (p.deg || 0) * Math.PI / 180; return Math.abs((c.x - p.x) * Math.sin(a) - (c.y - p.y) * Math.cos(a)) <= r + p.thick / 2; }

// ---- 部屋 ----
const rooms = new Map();
class Room {
  constructor(code){ this.code = code; this.players = new Map(); this.timer = null; this.lateTimer = null; this.reset(); }
  reset(){ this.phase = 'lobby'; this.level = initialLevel(); this.box = []; this.round = 0; this.deadline = 0; this.results = null; this.runStart = 0; this.winner = null;
    for (const p of this.players.values()){ p.ready = false; p.score = 0; p.status = 'idle'; p.pick = null; p.placed = false; } }
  pub(){
    return { t: 'state', phase: this.phase, deadline: this.deadline, now: Date.now(), round: this.round, target: T.TARGET, runStart: this.runStart,
      level: this.level, box: this.box, results: this.results, winner: this.winner, code: this.code,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score, ready: p.ready, status: p.status, pick: p.pick, placed: p.placed, finishTime: p.finishTime })) };
  }
  sync(){ const s = JSON.stringify(this.pub()); for (const p of this.players.values()){ if (p.ws.readyState !== 1) continue; if (p.ws.bufferedAmount > LIM.wsBuffered){ p.ws.terminate(); continue; } p.ws.send(s); } } // 受け取らずに溜め続ける相手は切る
  setTimer(ms, fn){ clearTimeout(this.timer); this.deadline = Date.now() + ms; this.timer = setTimeout(fn, ms); }
  all(pred){ return [...this.players.values()].every(pred); }

  startGame(){ this.reset(); this.startBox(); }
  startBox(){
    this.round++; this.phase = 'box';
    const n = this.players.size + 1, pool = [...TEMPLATES].sort(() => Math.random() - 0.5);
    this.box = []; for (let i = 0; i < n; i++){ const tp = pool[i % pool.length]; this.box.push({ id: i, name: tp.name, piece: tp.make(), sizable: !!tp.sizable, takenBy: null }); }
    for (const p of this.players.values()){ p.pick = null; p.placed = false; p.status = 'idle'; }
    this.setTimer(T.BOX, () => this.startPlace()); this.sync();
  }
  startPlace(){
    this.phase = 'place';
    for (const p of this.players.values()) if (p.pick === null) p.placed = true;
    this.setTimer(T.PLACE, () => this.startCount()); this.sync();
    if (this.all(p => p.placed)) this.startCount();
  }
  startCount(){
    this.phase = 'count';
    for (const p of this.players.values()){ p.status = 'waiting'; p.finishTime = null; p.killer = undefined; }
    this.runStart = Date.now() + T.COUNT;
    this.setTimer(T.COUNT, () => this.startRun()); this.sync();
  }
  startRun(){
    this.phase = 'run';
    this.setTimer(T.RUN, () => this.endRun());
    clearTimeout(this.lateTimer);
    this.lateTimer = setTimeout(() => { for (const p of this.players.values()) if (p.status === 'waiting') p.status = 'out'; this.sync(); this.checkRunEnd(); }, T.LATE);
    this.sync();
  }
  checkRunEnd(){ if (this.phase === 'run' && this.all(p => p.status !== 'waiting' && p.status !== 'running')) this.endRun(); }
  endRun(){
    clearTimeout(this.lateTimer);
    const ps = [...this.players.values()];
    for (const p of ps) if (p.status === 'running' || p.status === 'waiting') p.status = 'out';
    const fin = ps.filter(p => p.status === 'finished').sort((a, b) => a.finishTime - b.finishTime);
    const gain = new Map(ps.map(p => [p.id, { pts: 0, notes: [] }]));
    const add = (id, n, note) => { const g = gain.get(id); if (!g) return; g.pts += n; g.notes.push(`${note} +${n}`); };
    const everyone = fin.length === ps.length && ps.length > 0;
    if (!everyone){
      fin.forEach((p, i) => { add(p.id, 2, 'ゴール'); if (i === 0 && ps.length > 1) add(p.id, 1, '1着'); if (fin.length === 1 && ps.length > 1) add(p.id, 2, '単独'); });
      for (const p of ps) if (p.status === 'dead' && p.killer && p.killer !== p.id) add(p.killer, 1, `${p.name}を倒した`);
    }
    for (const p of ps) p.score += gain.get(p.id).pts;
    this.results = { everyone, rows: ps.map(p => ({ id: p.id, name: p.name, color: p.color, status: p.status, finishTime: p.finishTime, pts: gain.get(p.id).pts, notes: gain.get(p.id).notes, score: p.score })) };
    this.phase = 'results';
    // 決着: 目標の点に届いた人。誰も届かないまま LIM.rounds ラウンドたったら、その時点の最高点（置かれたピースが際限なく増えないように）
    const top = ps.filter(p => p.score >= T.TARGET).sort((a, b) => b.score - a.score)[0] || (this.round >= MAX_ROUNDS ? [...ps].sort((a, b) => b.score - a.score)[0] : undefined);
    this.setTimer(T.RESULTS, () => { if (top){ this.winner = { id: top.id, name: top.name, color: top.color }; this.phase = 'final'; this.setTimer(T.FINAL, () => { this.reset(); this.sync(); }); this.sync(); } else this.startBox(); });
    this.sync();
  }

  onMsg(p, m){
    switch (m.t){
      case 'ready': if (this.phase === 'lobby'){ p.ready = !p.ready; this.sync(); if (this.players.size >= 1 && this.all(q => q.ready)) this.startGame(); } break;
      case 'pick': if (this.phase === 'box' && p.pick === null && Number.isInteger(m.i)){ const b = this.box[m.i]; if (b && b.takenBy === null){ b.takenBy = p.id; p.pick = m.i; this.sync(); if (this.all(q => q.pick !== null)) this.startPlace(); } } break;
      case 'place': if (this.phase === 'place' && p.pick !== null && !p.placed){
          const b = this.box[p.pick], piece = b ? materialize(b.piece, m) : null;
          if (piece && placementOk(piece)){
            this.level.push({ ...piece, id: crypto.randomBytes(3).toString('hex'), owner: p.id, round: this.round }); p.placed = true; this.sync();
            if (this.all(q => q.placed)) this.startCount();
          } else p.ws.send(JSON.stringify({ t: 'reject' }));
        } break;
      case 'pass': if (this.phase === 'place' && !p.placed){ p.placed = true; this.sync(); if (this.all(q => q.placed)) this.startCount(); } break;
      case 'pos': { const x = +m.x, y = +m.y; if (!Number.isFinite(x) || !Number.isFinite(y)) break; const s = JSON.stringify({ t: 'pos', id: p.id, x: Math.max(-100, Math.min(T.W + 100, Math.round(x))), y: Math.max(-100, Math.min(T.H + 100, Math.round(y))) });
          for (const q of this.players.values()) if (q !== p && q.ws.readyState === 1 && q.ws.bufferedAmount < LIM.wsBuffered) q.ws.send(s); } break;
      case 'start': if (this.phase === 'run' && p.status === 'waiting'){ p.status = 'running'; this.sync(); } break;
      case 'dead': if (this.phase === 'run' && (p.status === 'running' || p.status === 'waiting')){ p.status = 'dead'; p.killer = typeof m.by === 'string' && this.level.some(q => q.owner === m.by) ? m.by : null; this.sync(); this.checkRunEnd(); } break; // 倒した人 = 実際にピースを置いている人だけ
      case 'finish': if (this.phase === 'run' && p.status === 'running'){ p.status = 'finished'; p.finishTime = Date.now() - this.runStart; this.sync(); this.checkRunEnd(); } break;
    }
  }
  leave(p){
    this.players.delete(p.id);
    if (this.players.size === 0){ clearTimeout(this.timer); clearTimeout(this.lateTimer); rooms.delete(this.code); return; }
    if (this.phase === 'lobby' && this.all(q => q.ready)) this.startGame();
    else if (this.phase === 'box' && this.all(q => q.pick !== null)) this.startPlace();
    else if (this.phase === 'place' && this.all(q => q.placed)) this.startCount();
    else if (this.phase === 'run') this.checkRunEnd();
    this.sync();
  }
}

// ---- ランキング（デイリー／固定コース）----
// 1コース(キー)＝1つの表。1人(pid)につき自己ベスト1件と、その走りのゴースト（圧縮済みの文字列）を持つ。
//   GET  /api/ping                → { cursorrun, now }
//   GET  /api/board/<key>         → { now, rows:[{pid,name,t,d,ts}] }  上位100件
//   POST /api/board/<key>         ← { pid, token, name, t, d, g }  → { ok, rows } | { ok:false, err }
//   GET  /api/ghost/<key>/<pid>   → { g }
// 保存先は DATA_DIR（既定 ./data）。boards/<key>.json と ghosts/<key>/<pid>.txt。
// 受け付けるのは知っているコース（固定コースと当日のデイリー）の、verify.js の検証を通った記録だけ。
// 行には sus（検証で数えた怪しい点の数）も残す。外には出さず、管理用 API で見る。
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const RANK = { TZ_MIN: 540, GRACE: 15 * 60000, MAX_ROWS: 500, MAX_G: 110000, MAX_BODY: 200000, GH_HZ: 30, GH_MAX: 18000 };
const boards = new Map(); // key → Map(pid → { pid, name, t, d, ts, th })
const keyOk = k => /^[\w-]{3,64}$/.test(k), pidOk = p => /^[\w-]{6,40}$/.test(p);
const dayKeyAt = ms => new Date(ms + RANK.TZ_MIN * 60000).toISOString().slice(0, 10);
function boardOf(key, create){ // 表。ファイルも無く create でもなければ null（でたらめな識別子で覚える量を増やされないように）
  let b = boards.get(key);
  if (b){ boards.delete(key); boards.set(key, b); return b; } // 使った順に並べ直す
  let txt = null; try { txt = fs.readFileSync(path.join(DATA, 'boards', key + '.json'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; } // 「無い」以外の失敗を空の表として扱うと、次の保存で本物の表を上書きしてしまう
  if (txt === null && !create) return null;
  b = new Map(); if (txt !== null) for (const e of JSON.parse(txt)) if (e && pidOk(e.pid)) b.set(e.pid, e);
  boards.set(key, b); while (boards.size > LIM.boardsInMemory) boards.delete(boards.keys().next().value);
  return b;
}
function saveBoard(key){
  const dir = path.join(DATA, 'boards'), fp = path.join(dir, key + '.json');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp + '.tmp', JSON.stringify([...boardOf(key, true).values()])); fs.renameSync(fp + '.tmp', fp);
}
const sorted = key => [...(boardOf(key) || new Map()).values()].sort((a, b) => a.t - b.t || a.ts - b.ts);
const rowsOf = key => sorted(key).filter(e => !e.hold).slice(0, 100).map(e => ({ pid: e.pid, name: e.name, t: e.t, d: e.d, ts: e.ts })); // 確認待ち(hold)の行は外に出さない
const ghostFile = (key, pid) => path.join(DATA, 'ghosts', key, pid + '.txt');
// pid は「最初に使った合言葉」に、表ごとではなく全体で結びつける。pid はランキングで誰でも見られるので、
// そうしないと他人の pid を名乗って、その人がまだ載っていない表（毎日のデイリー）に先に入り、本人を締め出せる。
const pidTh = new Map(), PID_LOG = path.join(DATA, 'pids.log'); // pid → 合言葉のハッシュの先頭 24 文字
function bindPid(pid, th){ pidTh.set(pid, th.slice(0, 24)); try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(PID_LOG, pid + ' ' + th.slice(0, 24) + '\n'); } catch (e) { console.error(e); } }
try { for (const line of fs.readFileSync(PID_LOG, 'utf8').split('\n')){ const [p, h] = line.trim().split(' '); if (pidOk(p || '') && /^[0-9a-f]{24}$/.test(h || '')) pidTh.set(p, h); } } catch (e) {}
try { for (const f of fs.readdirSync(path.join(DATA, 'boards'))){ if (!f.endsWith('.json')) continue; // 以前の版が作った表に載っている人も結びつける
  try { for (const e of JSON.parse(fs.readFileSync(path.join(DATA, 'boards', f), 'utf8'))) if (e && pidOk(e.pid) && /^[0-9a-f]{64}$/.test(e.th || '') && !pidTh.has(e.pid)) bindPid(e.pid, e.th); } catch (e) {} } } catch (e) {}
// ゴーストの形だけ確かめる: 版1・30Hz・長さがヘッダーと合う・長さがタイムと合う
function ghostOk(g, t){
  if (typeof g !== 'string' || g.length < 12 || g.length > RANK.MAX_G || !/^[A-Za-z0-9+/]+=*$/.test(g)) return false;
  const b = Buffer.from(g, 'base64'); if (b.length < 7 || b[0] !== 1 || b[1] !== RANK.GH_HZ) return false;
  const n = b[2] | b[3] << 8; if (n > RANK.GH_MAX || b.length !== 4 + n * 3) return false;
  const len = (n - 1) * 1000 / RANK.GH_HZ; return n === RANK.GH_MAX ? t >= len - 1500 : Math.abs(len - t) < 1500; // 上限(10分)で切れた走りは、タイムも 10 分以上のはず
}
function submitScore(key, m, ip){
  const now = Date.now(), day = /^d-(\d{4}-\d\d-\d\d)-/.exec(key);
  // デイリーは当日(JST)だけ受け付ける。日付をまたいだ直後の走りのために少しだけ猶予を持つ
  if (day && day[1] !== dayKeyAt(now) && day[1] !== dayKeyAt(now - RANK.GRACE)) return { ok: false, err: 'このデイリーの受付は終わりました' };
  const pid = String(m.pid || ''), token = String(m.token || ''), t = Math.round(+m.t), d = Math.round(+m.d), name = cleanName(m.name);
  if (!pidOk(pid) || token.length < 8 || token.length > 80 || !name || !(t >= 500 && t <= 3600000) || !(d >= 0 && d <= 9999) || !ghostOk(m.g, t)) return { ok: false, err: name ? '記録の形式が正しくありません' : 'その名前は使えません。名前を変えてください' };
  const course = ENV.verify ? courseFor(key) : null;
  if (ENV.verify && !course) return { ok: false, err: 'コースが新しくなっています。ページを読み込み直してください' };
  const th = crypto.createHash('sha256').update(token).digest('hex'), reg = pidTh.get(pid);
  if (reg && reg !== th.slice(0, 24)) return { ok: false, err: 'この記録は別の端末のものです' };
  const b = boardOf(key, true), cur = b.get(pid);
  if (cur && cur.th !== th) return { ok: false, err: 'この記録は別の端末のものです' };
  if (cur && t >= cur.t){ // タイムは据え置き。名前が違えば名前だけ変える（走りは確かめ直さない）
    if (cur.name !== name){ const old = cur.name; cur.name = name; try { saveBoard(key); } catch (e) { cur.name = old; throw e; } }
    return { ok: true, held: cur.hold || undefined, rows: rowsOf(key) };
  }
  // ここから先は、新しく載せる・タイムを縮める場合。走りを確かめる
  if (!reg && over('newPid', ip, LIM.newPid)) return { ok: false, code: 429, err: 'この接続からの新しい登録が多すぎます。明日また試してください' };
  if (over('badRun', ip, LIM.badRun)) return { ok: false, code: 429, err: '確かめられない記録が続いています。少し待ってからもう一度' };
  let sus = 0, hold = false;
  if (course){
    const v = verifyRun(course, m.g, t, d);
    if (!v.ok){ allow('badRun', ip, LIM.badRun); console.log(`[verify] ${key} ${pid} ${t}ms: ${v.why}`); return { ok: false, err: '走りを確かめられませんでした（' + v.why + '）' }; }
    sus = v.sus; hold = !!v.hold; if (hold) console.log(`[verify] ${key} ${pid} ${t}ms: 確認待ち（めり込み ${sus}）`);
  }
  let evict = null;
  if (!cur && b.size >= RANK.MAX_ROWS){ // 満員なら最下位と入れ替え。確認待ちの記録では入れ替えない
    const worst = sorted(key).pop(); if (hold || t >= worst.t) return { ok: false, err: 'ランキングが満員です' };
    evict = worst;
  }
  // 保存の順番: ゴーストを仮の名前で書く → 表を書き換えて保存 → ゴーストを本来の名前に → 追い出した行のゴーストを消す。途中で失敗したら表を元に戻す
  const gf = ghostFile(key, pid), row = { pid, name, t, d, ts: now, th, sus }; if (hold) row.hold = true;
  fs.mkdirSync(path.dirname(gf), { recursive: true }); fs.writeFileSync(gf + '.tmp', m.g);
  b.set(pid, row); if (evict) b.delete(evict.pid);
  try { saveBoard(key); } catch (e) { if (cur) b.set(pid, cur); else b.delete(pid); if (evict) b.set(evict.pid, evict); try { fs.unlinkSync(gf + '.tmp'); } catch (e2) {} throw e; }
  fs.renameSync(gf + '.tmp', gf);
  if (evict){ try { fs.unlinkSync(ghostFile(key, evict.pid)); } catch (e) {} }
  if (!reg){ bindPid(pid, th); allow('newPid', ip, LIM.newPid); } // 新しい人として数えるのは、実際に載ったときだけ
  return { ok: true, held: hold || undefined, rows: rowsOf(key) };
}
// 古いデイリーのゴーストを消す（行は残す）。起動時と6時間ごと
function pruneGhosts(){
  const lim = dayKeyAt(Date.now() - LIM.ghostDays * 86400000); let dirs = [];
  try { dirs = fs.readdirSync(path.join(DATA, 'ghosts')); } catch (e) { return; }
  for (const k of dirs){ const m = /^d-(\d{4}-\d\d-\d\d)-/.exec(k); if (m && m[1] < lim){ try { fs.rmSync(path.join(DATA, 'ghosts', k), { recursive: true, force: true }); } catch (e) {} } }
}
pruneGhosts(); setInterval(pruneGhosts, 6 * 3600000).unref();
function removeRow(key, pid){ // 管理用: 1行とそのゴーストを消す
  const b = boardOf(key); if (!b || !b.has(pid)) return false;
  b.delete(pid); try { fs.unlinkSync(ghostFile(key, pid)); } catch (e) {} saveBoard(key); return true;
}
function isAdmin(req){
  if (!ENV.admin) return false; const h = String(req.headers.authorization || ''), tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = crypto.createHash('sha256').update(tok).digest(), b = crypto.createHash('sha256').update(ENV.admin).digest(); return crypto.timingSafeEqual(a, b);
}
function readJson(req, res, json, cb){ // 本文を上限つきで読む
  let body = '', over = false;
  req.on('data', ch => { if (over) return; body += ch; if (body.length > RANK.MAX_BODY){ over = true; json(413, { ok: false, err: 'データが大きすぎます' }); req.destroy(); } });
  req.on('end', () => { if (over) return; let m; try { m = JSON.parse(body); } catch (e) { return json(400, { ok: false, err: '記録の形式が正しくありません' }); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return json(400, { ok: false, err: '記録の形式が正しくありません' });
    try { cb(m); } catch (e) { console.error(e); json(500, { ok: false, err: 'サーバーで保存に失敗しました' }); } });
}
function api(req, res, parts){
  const json = (code, o) => { if (res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(o)); };
  const [what, key, pid] = parts, ip = ipOf(req), post = req.method === 'POST';
  if (req.method !== 'GET' && !post) return json(405, { err: 'method not allowed' });
  if (!allow(post ? 'post' : 'get', ip, post ? LIM.post : LIM.get)) return json(429, { ok: false, err: 'アクセスが多すぎます。少し待ってからもう一度' });
  if (what === 'ping' && parts.length === 1 && !post) return json(200, { cursorrun: 1, now: Date.now() });
  if (what === 'board' && parts.length === 2 && keyOk(key)){
    if (!post) return json(200, { now: Date.now(), rows: rowsOf(key) });
    return readJson(req, res, json, m => { const r = submitScore(key, m, ip), code = r.ok ? 200 : r.code || 400; delete r.code; json(code, { now: Date.now(), ...r }); });
  }
  if (what === 'ghost' && parts.length === 3 && keyOk(key) && pidOk(pid) && !post){
    try { return json(200, { g: fs.readFileSync(ghostFile(key, pid), 'utf8') }); } catch (e) { return json(404, { err: 'not found' }); }
  }
  // ---- 管理用（ADMIN_TOKEN を設定したときだけ）。Authorization: Bearer <合言葉> ----
  if (what === 'admin' && ENV.admin){
    if (over('admin401', '*', LIM.admin401)) return json(429, { err: 'too many attempts' }); // 合言葉の総当たりへの備え。間違いが続くと、1分のあいだ管理用 API 全体を止める
    if (!isAdmin(req)){ allow('admin401', '*', LIM.admin401); return json(401, { err: 'unauthorized' }); }
    if (key === 'boards' && parts.length === 2 && !post){ let files = []; try { files = fs.readdirSync(path.join(DATA, 'boards')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch (e) {} return json(200, { boards: files.sort().reverse().map(k => ({ key: k, rows: (boardOf(k) || new Map()).size })) }); }
    if (key === 'board' && parts.length === 3 && keyOk(pid) && !post) return json(200, { key: pid, rows: sorted(pid).map(e => ({ pid: e.pid, name: e.name, t: e.t, d: e.d, ts: e.ts, sus: e.sus | 0, hold: !!e.hold })) }); // sus・確認待ちつきの全行
    if (key === 'approve' && parts.length === 2 && post) return readJson(req, res, json, m => { const b = keyOk(String(m.key)) && pidOk(String(m.pid)) ? boardOf(String(m.key)) : null, e = b && b.get(String(m.pid)); if (!e) return json(404, { ok: false }); delete e.hold; saveBoard(String(m.key)); console.log(`[admin] approved ${m.key} ${m.pid}`); json(200, { ok: true }); });
    if (key === 'remove' && parts.length === 2 && post) return readJson(req, res, json, m => { const ok = keyOk(String(m.key)) && pidOk(String(m.pid)) && removeRow(String(m.key), String(m.pid)); if (ok) console.log(`[admin] removed ${m.key} ${m.pid}`); json(ok ? 200 : 404, { ok }); });
  }
  json(404, { err: 'not found' });
}

// ---- HTTP (静的配信) + WebSocket ----
// 外に出すのは PUBLIC_FILES だけ。index.html の <script> と同じ中身だけを実行できるようにする（CSP）。
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/og.png': 'og.png', '/robots.txt': 'robots.txt' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
const same = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p); // 道の比べ方。Windows は大文字小文字を区別しない
const cache = new Map(); // ファイル → { mtime, raw, gz, csp }
function fileOf(fp){
  const st = fs.statSync(fp), c = cache.get(fp); if (c && c.mtime === st.mtimeMs) return c;
  const raw = fs.readFileSync(fp), ext = path.extname(fp), e = { mtime: st.mtimeMs, raw, gz: /\.(html|js|md|json|txt|svg)$/.test(ext) ? zlib.gzipSync(raw) : null, csp: '' };
  if (ext === '.html'){ // ページに書いてある <script> だけを許す（ハッシュ）。差し込まれたスクリプトは動かない
    // ブラウザは改行を LF にそろえてからハッシュを取るので、ここでもそろえる（Windows で取り出したファイルは CRLF になっている）
    const hashes = [...raw.toString('utf8').replace(/\r\n?/g, '\n').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'");
    e.csp = hashes.join(' ') || "'none'";
  }
  cache.set(fp, e); return e;
}
const server = http.createServer({ connectionsCheckingInterval: 5000 }, (req, res) => { // 5秒ごとに、時間切れの接続を片づける
  try {
    let file; try { file = decodeURIComponent(String(req.url).split('?')[0]); } catch (e) { res.writeHead(400); res.end('bad request'); return; }
    if (file.startsWith('/api/')) return api(req, res, file.slice(5).split('/'));
    if (req.method !== 'GET' && req.method !== 'HEAD'){ res.writeHead(405); res.end('method not allowed'); return; }
    const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); };
    if (!allow('get', ipOf(req), LIM.get)){ res.writeHead(429); res.end('too many requests'); return; }
    let fp = null;
    if (Object.prototype.hasOwnProperty.call(PUBLIC_FILES, file)) fp = path.join(__dirname, PUBLIC_FILES[file]);
    else if (ENV.serveAll && !/[:\\]|\/\//.test(file)){ // 開発用: 記録の保存先・node_modules・ドットで始まるもの以外は全部。URL ではなく、解決した後の道で判断する
      const q = path.join(__dirname, path.normalize(file)), rel = path.relative(__dirname, q).toLowerCase().split(path.sep).join('/');
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/(^|\/)(data|node_modules|\.[^/]*)(\/|$)/.test(rel) && same(q) !== same(DATA) && !same(q).startsWith(same(DATA) + path.sep)) fp = q;
    }
    if (!fp || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return notFound();
    const e = fileOf(fp), gz = e.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const head = { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Vary': 'Accept-Encoding' };
    if (e.csp){ // ページに書いてあるスクリプトだけ・通信は自分の場所だけ（WebSocket は同じホストを名指しする。'self' が ws を含まないブラウザがある）
      const host = /^[\w.-]+(:\d+)?$/.test(String(req.headers.host || '')) ? req.headers.host : '';
      head['Content-Security-Policy'] = `default-src 'self'; script-src ${e.csp}; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'${host ? ` ws://${host} wss://${host}` : ''}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${ENV.frame}`;
    }
    if (gz) head['Content-Encoding'] = 'gzip';
    const body = gz ? e.gz : e.raw; head['Content-Length'] = body.length;
    res.writeHead(200, head); res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) { console.error(err); try { if (!res.headersSent) res.writeHead(500); res.end('error'); } catch (e2) {} }
});
server.headersTimeout = 10000; server.requestTimeout = 20000; server.keepAliveTimeout = 5000; // 遅く送り続けて接続を占有する相手への備え
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const wsByIp = new Map(); let wsCount = 0;
// 上限を超えた接続は、WebSocket として受ける前に断る。受けてから閉じると、閉じ終わるまで枠を占めたままになり、1人で全体の上限を埋められる
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const ip = ipOf(req), refuse = () => { try { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (e) {} socket.destroy(); };
  if (ENV.limits && (!allow('wsUp', ip, LIM.wsUp) || (wsByIp.get(ip) || 0) >= LIM.wsPerIp || wsCount >= LIM.wsTotal)) return refuse();
  wsByIp.set(ip, (wsByIp.get(ip) || 0) + 1); wsCount++;
  let released = false;
  socket.on('close', () => { if (released) return; released = true; wsCount--; const left = (wsByIp.get(ip) || 1) - 1; if (left > 0) wsByIp.set(ip, left); else wsByIp.delete(ip); });
  try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); } catch (e) { socket.destroy(); }
});
wss.on('connection', (ws, req) => {
  ws.on('error', () => {}); // 最初に付ける。付ける前に大きすぎるメッセージなどが来ると、拾われない例外になる
  const ip = ipOf(req); ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  let room = null, player = null; const cid = crypto.randomBytes(4).toString('hex');
  ws.on('message', data => {
    try {
      if (!allow('wsMsg', cid, LIM.wsMsg)){ ws.close(); return; } // 1秒に送れる数を超えた接続は切る
      let m; try { m = JSON.parse(data); } catch (e) { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      if (!player){
        if (m.t !== 'join') return;
        if (!allow('wsJoin', ip, LIM.wsJoin)){ ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
        const code = String(m.room || 'main').replace(/[^\w-]/g, '').slice(0, 24) || 'main';
        if (!rooms.has(code) && rooms.size >= LIM.rooms){ ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
        room = rooms.get(code) || (rooms.set(code, new Room(code)), rooms.get(code));
        if (room.players.size >= 8){ ws.send(JSON.stringify({ t: 'full' })); ws.close(); room = null; return; }
        const used = new Set([...room.players.values()].map(p => p.color));
        const name = cleanName(typeof m.name === 'string' ? m.name : '') || 'player';
        // 進行中の部屋に入った人は今のラウンドは見学（out）、次の箱から参加
        player = { id: crypto.randomBytes(4).toString('hex'), name, color: COLORS.find(c => !used.has(c)) || COLORS[0], ws, score: 0, ready: false, status: room.phase === 'lobby' ? 'idle' : 'out', pick: null, placed: true, finishTime: null };
        room.players.set(player.id, player);
        ws.send(JSON.stringify({ t: 'hello', id: player.id, now: Date.now() }));
        room.sync();
        console.log(`[${code}] + ${player.name} (${room.players.size})`);
        return;
      }
      room.onMsg(player, m);
    } catch (err) { console.error(err); }
  });
  ws.on('close', () => {
    if (room && player){ try { room.leave(player); } catch (err) { console.error(err); } console.log(`[${room.code}] - ${player.name}`); }
  });
});
// 応答のない接続を片づける（30秒ごとに ping）
setInterval(() => { for (const ws of wss.clients){ if (!ws.isAlive){ ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 30000).unref();
process.on('uncaughtException', err => { console.error('[uncaught]', err); }); // 1件のおかしな入力で全員を落とさない
server.listen(PORT, HOST, () => console.log(`Cursor Run server: http://localhost:${PORT}/?room=main${ENV.serveAll ? ' (SERVE_ALL)' : ''}${ENV.admin ? ' (admin on)' : ''}`));
