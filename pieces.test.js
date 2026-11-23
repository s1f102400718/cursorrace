// 新ピース（図鑑採用分）が本編の prims/stepPieces/ruleHit/drawPieces で例外なく動くか
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const grad = { addColorStop(){} };
const ctxStub = new Proxy({}, { get: (t, k) => k === 'createRadialGradient' ? () => grad : k === 'measureText' ? () => ({ width: 0 }) : () => {} });
const el = () => ({ textContent: '', innerHTML: '', hidden: false, addEventListener(){}, getContext: () => ctxStub, width: 0, height: 0 });
global.document = { getElementById: el, documentElement: {}, addEventListener(){} };
global.window = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, addEventListener(){} };
global.getComputedStyle = () => ({ getPropertyValue: () => '#000' });
global.localStorage = { getItem: () => null, setItem(){} };
global.performance = { now: () => 0 }; global.requestAnimationFrame = () => {};
const m = new Function(js.replace(/requestAnimationFrame\(loop\);\s*$/, '') + ';return { prims, stepPieces, ruleHit, drawPieces, materialize, placementOk, bounds, resetPieceState, sweepHit };')();
const START = { x: 90, y: 360 }, GOAL = { x: 1190, y: 360 };
const pieces = [
  { id: 'a', t: 'aimed', x: 640, y: 110, speed: 340, interval: 0.9, r: 6, life: 4 },
  { id: 'b', t: 'rotlaser', x: 640, y: 360, len: 700, rpm: 6, thick: 10, on: 1.6, warn: 0.7, off: 1.5, phase: 0 },
  { id: 'c', t: 'rain', x: 440, w: 400, interval: 0.14, speed: 300, r: 6, seed: 3 },
  { id: 'd', t: 'slidelaser', x: 640, y: 360, len: 260, dx: 360, period: 3, thick: 8 },
  { id: 'e', t: 'crusher', x: 550, y: 360, w: 180, h: 400, gap: 60, travel: 130, period: 2 },
  { id: 'f', t: 'bar', x: 640, y: 360, len: 360, thick: 14, rpm: 15, blades: 4 },
  { id: 'g', t: 'stretch', x: 640, y: 360, lmin: 80, lmax: 520, period: 2.5, rpm: 10, thick: 14 },
  { id: 'h', t: 'mine', x: 500, y: 300, trigger: 70, fuse: 0.5, blast: 90, hold: 0.3, cooldown: 2 },
  { id: 'i', t: 'warnfloor', x: 510, y: 270, w: 260, h: 180, period: 3, duty: 0.3, warn: 0.6 },
  { id: 'j', t: 'chaser', x: 900, y: 600, speed: 170, r: 18 },
  { id: 'k', t: 'shadow', x: 100, y: 100, delay: 1.5, r: 10 },
  { id: 'l', t: 'speedzone', x: 300, y: 500, w: 240, h: 180, limit: 400 },
  { id: 'm', t: 'nostop', x: 700, y: 500, w: 240, h: 180, min: 150, grace: 0.5 },
];
let fail = 0;
try {
  // 1) 3秒ぶん回す（カーソルは地雷の近く→区画内を低速で）
  m.resetPieceState(); const history = []; let maxPrims = 0;
  for (let f = 0; f < 240; f++){ const t = f / 60, cur = f < 60 ? { x: 520, y: 320 } : { x: 760 + (f % 2), y: 560 };
    const env = { t, dt: 1 / 60, cur, prev: cur, have: true, speed: f < 60 ? 300 : 30, history };
    m.stepPieces(pieces, env); const ps = m.prims({ pieces }, t, env); maxPrims = Math.max(maxPrims, ps.length);
    history.push({ x: cur.x, y: cur.y, t }); m.ruleHit(pieces, env); m.drawPieces(pieces, ps, t); }
  console.log('prims max:', maxPrims);
  // 2) 停止禁止: 区画内で低速 3秒 → 死ぬ
  const envSlow = { t: 4, dt: 1 / 60, cur: { x: 760, y: 560 }, prev: null, have: true, speed: 30, history };
  const r = m.ruleHit(pieces, envSlow); console.log('nostop kills slow cursor:', r && r.t === 'nostop');
  // 3) 速度制限: 区画内で高速 → 死ぬ / 区画外なら死なない
  const envFast = { ...envSlow, cur: { x: 400, y: 560 }, speed: 900 }; console.log('speedzone kills fast cursor:', (m.ruleHit([pieces[11]], envFast) || {}).t === 'speedzone', '| outside ok:', m.ruleHit([pieces[11]], { ...envFast, cur: { x: 100, y: 100 } }) === null);
  // 4) 地雷: 近づいて fuse 後に爆風が出る
  m.resetPieceState(); const mine = pieces[7]; let armedBefore = false; for (let f = 0; f < 40; f++){ m.stepPieces([mine], { t: 0.5 + f / 60, dt: 1 / 60, cur: { x: 520, y: 320 }, have: true, speed: 0, history: [] }); if (f === 10) armedBefore = m.prims({ pieces: [mine] }, 0.67).length === 0; }
  const blast = m.prims({ pieces: [mine] }, 1.15).some(p => p.r === 90); console.log('mine: no blast during fuse:', armedBefore, '| blasts after fuse:', blast);
  // 5) 狙い撃ち: 発射時刻にカーソルへ向かう弾が1発
  m.resetPieceState(); const aimed = pieces[0]; let count = 0; for (let f = 0; f < 70; f++){ m.stepPieces([aimed], { t: 0.5 + f / 60, dt: 1 / 60, cur: { x: 640, y: 600 }, have: true, speed: 0, history: [] }); } count = m.prims({ pieces: [aimed] }, 1.6).length; console.log('aimed bullets after 1 interval:', count, count === 1 ? '(1発ずつ OK)' : '(NG)'); if (count !== 1) fail++;
  // 6) 設置検証: 範囲指定は w,h 必須・最小80、パッド上は拒否
  const z = { t: 'speedzone', x: 0, y: 0, w: 240, h: 180, limit: 400 };
  console.log('sizable needs w/h:', m.materialize(z, { x: 300, y: 300 }) === null, '| ok rect:', !!m.materialize(z, { x: 300, y: 300, w: 200, h: 120 }), '| over start pad rejected:', !m.placementOk(m.materialize(z, { x: 40, y: 300, w: 200, h: 120 }), START, GOAL), '| tiny rejected:', m.materialize(z, { x: 300, y: 300, w: 40, h: 40 }) === null);
  const rl = { t: 'rotlaser', x: 0, y: 0, len: 700, rpm: 6, thick: 10, on: 1.6, warn: 0.7, off: 1.5 }; console.log('rotlaser placeable mid-arena:', m.placementOk(m.materialize(rl, { x: 640, y: 360 }), START, GOAL));
  if (!(r && r.t === 'nostop') || !blast) fail++;
} catch (e) { fail++; console.log('ERR', e.stack); }
console.log(fail ? 'PIECES FAIL' : 'PIECES OK');
