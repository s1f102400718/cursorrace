'use strict';
// Cursor Run マルチプレイサーバー（Ultimate Chicken Horse 方式）
//   npm install && node server.js  →  http://localhost:8080/?room=abc
// サーバーの役割: フェーズ進行、箱（ピース候補）の生成、設置の受理と検証、レースクロック、採点。
// 当たり判定は各クライアントが行い、死亡/ゴールを申告する（身内用、チート耐性なし）。
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const T = {
  W: 1280, H: 720, PAD_R: 46,
  BOX: 12000, PLACE: 25000, COUNT: 3000, RUN: 45000, RESULTS: 8000, FINAL: 12000,
  LATE: 5000,          // GO後これだけ待ってもスタートパッドに乗らなければ脱落
  TARGET: 15,          // この点に達したら決着
};
if (process.env.FAST) Object.assign(T, { BOX: 400, PLACE: 400, COUNT: 200, RUN: 1500, RESULTS: 200, FINAL: 200, LATE: 400 }); // 自動テスト用
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
  sync(){ const s = JSON.stringify(this.pub()); for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
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
    const top = ps.filter(p => p.score >= T.TARGET).sort((a, b) => b.score - a.score)[0];
    this.setTimer(T.RESULTS, () => { if (top){ this.winner = { id: top.id, name: top.name, color: top.color }; this.phase = 'final'; this.setTimer(T.FINAL, () => { this.reset(); this.sync(); }); this.sync(); } else this.startBox(); });
    this.sync();
  }

  onMsg(p, m){
    switch (m.t){
      case 'ready': if (this.phase === 'lobby'){ p.ready = !p.ready; this.sync(); if (this.players.size >= 1 && this.all(q => q.ready)) this.startGame(); } break;
      case 'pick': if (this.phase === 'box' && p.pick === null){ const b = this.box[m.i]; if (b && b.takenBy === null){ b.takenBy = p.id; p.pick = m.i; this.sync(); if (this.all(q => q.pick !== null)) this.startPlace(); } } break;
      case 'place': if (this.phase === 'place' && p.pick !== null && !p.placed){
          const b = this.box[p.pick], piece = b ? materialize(b.piece, m) : null;
          if (piece && placementOk(piece)){
            this.level.push({ ...piece, id: crypto.randomBytes(3).toString('hex'), owner: p.id, round: this.round }); p.placed = true; this.sync();
            if (this.all(q => q.placed)) this.startCount();
          } else p.ws.send(JSON.stringify({ t: 'reject' }));
        } break;
      case 'pass': if (this.phase === 'place' && !p.placed){ p.placed = true; this.sync(); if (this.all(q => q.placed)) this.startCount(); } break;
      case 'pos': { const x = +m.x, y = +m.y; if (!Number.isFinite(x) || !Number.isFinite(y)) break; const s = JSON.stringify({ t: 'pos', id: p.id, x: Math.round(x), y: Math.round(y) });
          for (const q of this.players.values()) if (q !== p && q.ws.readyState === 1) q.ws.send(s); } break;
      case 'start': if (this.phase === 'run' && p.status === 'waiting'){ p.status = 'running'; this.sync(); } break;
      case 'dead': if (this.phase === 'run' && (p.status === 'running' || p.status === 'waiting')){ p.status = 'dead'; p.killer = typeof m.by === 'string' ? m.by : null; this.sync(); this.checkRunEnd(); } break;
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
// タイムの正しさは検証しない（身内用）。防ぐのは「他人の記録の上書き」と「壊れたデータ」だけ。
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const RANK = { TZ_MIN: 540, GRACE: 15 * 60000, MAX_ROWS: 500, MAX_G: 110000, MAX_BODY: 200000, GH_HZ: 30, GH_MAX: 18000 };
const boards = new Map(); // key → Map(pid → { pid, name, t, d, ts, th })
const keyOk = k => /^[\w-]{3,64}$/.test(k), pidOk = p => /^[\w-]{6,40}$/.test(p);
const dayKeyAt = ms => new Date(ms + RANK.TZ_MIN * 60000).toISOString().slice(0, 10);
function boardOf(key){
  let b = boards.get(key);
  if (!b){ b = new Map(); try { for (const e of JSON.parse(fs.readFileSync(path.join(DATA, 'boards', key + '.json'), 'utf8'))) b.set(e.pid, e); } catch (e) {} boards.set(key, b); }
  return b;
}
function saveBoard(key){
  const dir = path.join(DATA, 'boards'), fp = path.join(dir, key + '.json');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp + '.tmp', JSON.stringify([...boardOf(key).values()])); fs.renameSync(fp + '.tmp', fp);
}
const sorted = key => [...boardOf(key).values()].sort((a, b) => a.t - b.t || a.ts - b.ts);
const rowsOf = key => sorted(key).slice(0, 100).map(e => ({ pid: e.pid, name: e.name, t: e.t, d: e.d, ts: e.ts }));
const ghostFile = (key, pid) => path.join(DATA, 'ghosts', key, pid + '.txt');
// ゴーストの形だけ確かめる: 版1・30Hz・長さがヘッダーと合う・長さがタイムと合う
function ghostOk(g, t){
  if (typeof g !== 'string' || g.length < 12 || g.length > RANK.MAX_G || !/^[A-Za-z0-9+/]+=*$/.test(g)) return false;
  const b = Buffer.from(g, 'base64'); if (b.length < 7 || b[0] !== 1 || b[1] !== RANK.GH_HZ) return false;
  const n = b[2] | b[3] << 8; if (b.length !== 4 + n * 3) return false;
  return n === RANK.GH_MAX || Math.abs((n - 1) * 1000 / RANK.GH_HZ - t) < 1500;
}
function submitScore(key, m){
  const now = Date.now(), day = /^d-(\d{4}-\d\d-\d\d)-/.exec(key);
  // デイリーは当日(JST)だけ受け付ける。日付をまたいだ直後の走りのために少しだけ猶予を持つ
  if (day && day[1] !== dayKeyAt(now) && day[1] !== dayKeyAt(now - RANK.GRACE)) return { ok: false, err: 'このデイリーの受付は終わりました' };
  const pid = String(m.pid || ''), token = String(m.token || ''), t = Math.round(+m.t), d = Math.round(+m.d), name = String(m.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  if (!pidOk(pid) || token.length < 8 || token.length > 80 || !name || !(t >= 500 && t <= 3600000) || !(d >= 0 && d <= 9999) || !ghostOk(m.g, t)) return { ok: false, err: '記録の形式が正しくありません' };
  const b = boardOf(key), th = crypto.createHash('sha256').update(token).digest('hex'), cur = b.get(pid);
  if (cur && cur.th !== th) return { ok: false, err: 'この記録は別の端末のものです' };
  if (cur && t >= cur.t && cur.name === name) return { ok: true, rows: rowsOf(key) };
  if (!cur && b.size >= RANK.MAX_ROWS){ // 満員なら最下位と入れ替え
    const worst = sorted(key).pop(); if (t >= worst.t) return { ok: false, err: 'ランキングが満員です' };
    b.delete(worst.pid); try { fs.unlinkSync(ghostFile(key, worst.pid)); } catch (e) {}
  }
  if (!cur || t < cur.t){
    fs.mkdirSync(path.dirname(ghostFile(key, pid)), { recursive: true }); fs.writeFileSync(ghostFile(key, pid), m.g);
    b.set(pid, { pid, name, t, d, ts: now, th });
  } else cur.name = name; // タイムは据え置きで名前だけ変更
  saveBoard(key);
  return { ok: true, rows: rowsOf(key) };
}
function api(req, res, parts){
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const [what, key, pid] = parts;
  if (what === 'ping' && parts.length === 1) return json(200, { cursorrun: 1, now: Date.now() });
  if (what === 'board' && parts.length === 2 && keyOk(key)){
    if (req.method === 'GET') return json(200, { now: Date.now(), rows: rowsOf(key) });
    if (req.method === 'POST'){
      let body = '', over = false;
      req.on('data', ch => { if (over) return; body += ch; if (body.length > RANK.MAX_BODY){ over = true; json(413, { ok: false, err: 'データが大きすぎます' }); req.destroy(); } });
      req.on('end', () => { if (over) return; let m; try { m = JSON.parse(body); } catch (e) { return json(400, { ok: false, err: '記録の形式が正しくありません' }); }
        try { const r = submitScore(key, m || {}); json(r.ok ? 200 : 400, { now: Date.now(), ...r }); } catch (e) { console.error(e); json(500, { ok: false, err: 'サーバーで保存に失敗しました' }); } });
      return;
    }
  }
  if (what === 'ghost' && parts.length === 3 && keyOk(key) && pidOk(pid) && req.method === 'GET'){
    try { return json(200, { g: fs.readFileSync(ghostFile(key, pid), 'utf8') }); } catch (e) { return json(404, { err: 'not found' }); }
  }
  json(404, { err: 'not found' });
}

// ---- HTTP (静的配信) + WebSocket ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let file; try { file = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end('bad request'); return; }
  if (file.startsWith('/api/')) return api(req, res, file.slice(5).split('/'));
  if (file === '/') file = '/index.html';
  const fp = path.join(__dirname, path.normalize(file));
  if (/^\/(data|node_modules)(\/|$)|\/\./.test(file)){ res.writeHead(404); res.end('not found'); return; } // 記録の保存先などは配信しない
  if (!fp.startsWith(__dirname) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()){ res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let room = null, player = null;
  ws.on('message', data => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!player){
      if (m.t !== 'join') return;
      const code = String(m.room || 'main').replace(/[^\w-]/g, '').slice(0, 24) || 'main';
      room = rooms.get(code) || (rooms.set(code, new Room(code)), rooms.get(code));
      if (room.players.size >= 8){ ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
      const used = new Set([...room.players.values()].map(p => p.color));
      // 進行中の部屋に入った人は今のラウンドは見学（out）、次の箱から参加
      player = { id: crypto.randomBytes(4).toString('hex'), name: String(m.name || 'player').slice(0, 12), color: COLORS.find(c => !used.has(c)) || COLORS[0], ws, score: 0, ready: false, status: room.phase === 'lobby' ? 'idle' : 'out', pick: null, placed: true, finishTime: null };
      room.players.set(player.id, player);
      ws.send(JSON.stringify({ t: 'hello', id: player.id, now: Date.now() }));
      room.sync();
      console.log(`[${code}] + ${player.name} (${room.players.size})`);
      return;
    }
    room.onMsg(player, m);
  });
  ws.on('close', () => { if (room && player){ room.leave(player); console.log(`[${room.code}] - ${player.name}`); } });
});
server.listen(PORT, () => console.log(`Cursor Run server: http://localhost:${PORT}/?room=main`));
