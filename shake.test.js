// 画面の振動のテスト（node shake.test.js）
//  1) 山(shakeEnv)は全ピースで 0..1、揺れ幅は上限内、設定で切れる
//  2) 横断レーザー(beam): 照射中だけ線の全長で当たる／予告・休みは当たらない／パッドを貫く設置は不可
//  3) 振動は判定に関わらない: 振動 入/切 で、同じ入力から同じ結果（死亡数・タイム・走行記録）になる
//  4) 振動中の描画（揺らさない絵の重ね描き）が例外なく回り、描画先が画面に戻る
const { load } = require('./harness.js');
let fail = 0; const ok = (c, msg) => { if (!c){ fail++; console.log('  NG', msg); } return c; };
const NAMES = ['T', 'SHAKE', 'LAB', 'COURSES', 'ARCH', 'RNG', 'frame', 'prims', 'hit', 'sweepHit', 'solveRoom', 'padSafe', 'shakeEnv', 'roomShake', 'shakeOffset', 'beamState', 'materialize', 'placementOk', 'bounds',
  'openLab', 'update', 'samples', 'state', 'deaths', 'finalTime', 'lastRun', 'cur', 'ctx', 'mainCtx', 'watchLast', 'shakeKey', 'course'];

// ラボをBOTの経路で完走させ、結果を返す
function runLab(shakeOn){
  const { m, clock, errors } = load(NAMES);
  m.SHAKE.on = shakeOn;
  const bot = []; let t = 0, pos = m.LAB.start, solved = true;
  m.LAB.rooms.forEach((room, i) => { const s = m.solveRoom(room, pos, room.exit, t, true, 40); if (!s.ok){ solved = false; return; } for (const p of s.path) bot.push(Math.round(p.t * 1000), i, p.x, p.y, 1); t += s.time; pos = s.path[s.path.length - 1]; });
  if (!solved) return { solved };
  m.openLab(); m.samples.push({ x: bot[2], y: bot[3] }); clock.t += 16; m.update(clock.t);
  for (let i = 0; i < 400 && m.state === 'count'; i++){ clock.t += 16; m.update(clock.t); }
  const t0 = clock.t; let last = -1, shaken = 0, moved = 0, ctxLeak = 0;
  for (let i = 0; i < bot.length && m.state === 'race'; i += 5){
    if (bot[i] === last) continue; last = bot[i]; clock.t = t0 + bot[i]; m.samples.push({ x: bot[i + 2], y: bot[i + 3] }); m.update(clock.t);
    if (m.roomShake(m.LAB.rooms[bot[i + 1]].pieces, bot[i] / 1000) > 0.5) shaken++;
    if (m.cur.x !== bot[i + 2] || m.cur.y !== bot[i + 3]) moved++;   // カーソルは入力した位置のまま
    if (m.ctx !== m.mainCtx) ctxLeak++;                               // 描画先が画面に戻っている
  }
  return { solved, m, clock, errors, state: m.state, deaths: m.deaths, time: m.finalTime, rec: JSON.stringify(m.lastRun && m.lastRun.s), shaken, moved, ctxLeak };
}

(() => {
  const { m } = load(NAMES);

  console.log('1) 山と揺れ幅');
  const F = m.frame(1, false), samplePieces = [...m.LAB.rooms.flatMap(r => r.pieces), ...m.COURSES.flatMap(c => c.rooms.flatMap(r => r.pieces))];
  for (const name of Object.keys(m.ARCH)) samplePieces.push(...m.ARCH[name](m.RNG('shake|' + name), 0.8, F).pieces);
  samplePieces.push({ id: 'a', t: 'aimed', x: 640, y: 110, speed: 340, interval: 0.9, r: 6, life: 4 }, { id: 'h', t: 'mine', x: 500, y: 300, trigger: 70, fuse: 0.5, blast: 90, hold: 0.3, cooldown: 2 }, { id: 'j', t: 'chaser', x: 900, y: 600, speed: 170, r: 18 });
  const types = new Set(); let bad = 0, peak = {};
  for (const p of samplePieces){ types.add(p.t); for (let t = 0; t < 12; t += 0.013){ const e = m.shakeEnv(p, t); if (!(e >= 0 && e <= 1)) bad++; peak[p.t] = Math.max(peak[p.t] || 0, e); } }
  ok(bad === 0, `山が 0..1 を外れた ${bad} 回`); ok(types.size >= 18, 'ピースの種類が足りない: ' + [...types]);
  ok(Object.entries(peak).every(([k, v]) => v > 0.6 || k === 'mine'), '山が立たない型がある: ' + JSON.stringify(peak)); // 地雷は踏まれるまで山が立たない
  const beams = m.LAB.rooms[0].pieces, warm = m.COURSES[0].rooms[0].pieces;
  let maxAmp = 0, quiet = 0; for (let t = 0; t < 20; t += 0.01){ const a = m.roomShake(beams, t); maxAmp = Math.max(maxAmp, a); if (a < 0.05) quiet++; }
  ok(maxAmp > 5 && maxAmp <= m.T.SHAKE.MAX, '横断レーザーの揺れ幅: ' + maxAmp.toFixed(2)); ok(quiet > 100, '静かな時間が無い（撃っていない間は止まるはず）');
  ok(m.roomShake(warm, 1.23) === 0, '振動するピースが無い部屋で揺れた');
  m.SHAKE.gain = 2; ok(m.roomShake(beams, 0.9) <= m.T.SHAKE.MAX * 2, '強さ×2 の上限'); m.SHAKE.gain = 1;
  m.SHAKE.on = false; ok(m.roomShake(beams, 0.9) === 0, '切にしても揺れる'); m.SHAKE.on = true;
  const o1 = m.shakeOffset(7, 3.21), o2 = m.shakeOffset(7, 3.21); ok(o1.x === o2.x && o1.y === o2.y && Math.abs(o1.x) <= 7 && Math.abs(o1.y) <= 7, '揺れが時刻だけで決まらない／幅を超える');
  ok(m.shakeOffset(0, 1).amp === 0 && m.shakeOffset(0, 1).x === 0, '揺れ幅 0 でずれる');
  console.log(`   ${samplePieces.length}個・${types.size}種 / 横断レーザーの最大 ${maxAmp.toFixed(1)}px`);

  console.log('2) 横断レーザー');
  const b = { t: 'beam', x: 400, y: 360, deg: 90, thick: 16, warn: 0.8, on: 0.9, off: 1.5, phase: 0 }, room = { pieces: [b] };
  const at = (t, x, y) => !!m.sweepHit(m.prims(room, t), x, y, x, y);
  ok(!at(0.4, 400, 100) && !at(0.4, 400, 700), '予告中に当たる');
  ok(at(1.0, 400, 20) && at(1.0, 400, 360) && at(1.0, 400, 700), '照射中に端から端まで当たらない');
  ok(!at(1.0, 440, 360), '線の外で当たる'); ok(!at(2.2, 400, 360), '休みで当たる');
  ok(m.shakeEnv(b, 0.4) === 0 && m.shakeEnv(b, 1.0) > 0.7 && m.shakeEnv(b, 2.4) < 0.05, '揺れが 予告で無し・照射で大きく・休みで止まる になっていない');
  const diag = { t: 'beam', x: 640, y: 360, deg: 45, thick: 12, warn: 0.5, on: 1, off: 1, phase: 0 };
  ok(!!m.sweepHit(m.prims({ pieces: [diag] }, 1), 340, 60, 340, 60) && !m.sweepHit(m.prims({ pieces: [diag] }, 1), 340, 660, 340, 660), '斜めの線');
  ok(!m.padSafe([b], { x: 400, y: 600 }, 50) && m.padSafe([b], { x: 600, y: 360 }, 50), 'パッドの安全判定');
  const S = { x: 90, y: 360 }, G = { x: 1190, y: 360 }, rel = { t: 'beam', x: 0, y: 0, deg: 0, thick: 14, warn: 0.8, on: 0.8, off: 1.6, phase: 0 };
  ok(!m.placementOk(m.materialize(rel, { x: 640, y: 360 }), S, G), 'パッドを貫く横線を置けてしまう');
  ok(m.placementOk(m.materialize(rel, { x: 640, y: 200 }), S, G) && m.placementOk(m.materialize({ ...rel, deg: 90 }, { x: 640, y: 360 }), S, G), 'パッドを避けた線が置けない');

  console.log('3) 振動は判定に関わらない');
  const A = runLab(true), B = runLab(false);
  if (ok(A.solved && B.solved, 'ラボの部屋をBOTが解けない')){
    ok(A.state === 'done' && A.deaths === 0, `振動ありで完走しない: ${A.state} deaths=${A.deaths}`);
    ok(B.state === 'done' && B.deaths === 0, `振動なしで完走しない: ${B.state} deaths=${B.deaths}`);
    ok(A.time === B.time && A.rec === B.rec, '振動の入/切で結果が変わった');
    ok(A.shaken > 20 && B.shaken === 0, `振動している時間: 入 ${A.shaken} / 切 ${B.shaken}`);
    ok(A.moved === 0, `カーソルが入力位置からずれた ${A.moved} 回`);
    console.log(`   タイム ${A.time} = ${B.time} / 振動していたフレーム ${A.shaken}`);

    console.log('4) 描画');
    ok(A.ctxLeak === 0, '描画先が画面に戻っていない'); ok(A.errors.length === 0 && B.errors.length === 0, '例外: ' + A.errors.concat(B.errors).slice(0, 2).join('\n'));
    A.m.watchLast(); for (let i = 0; i < 120; i++){ A.clock.t += 16; A.m.update(A.clock.t); } // リプレイ中も揺れる（中心は追っている走り）
    ok(A.m.state === 'watch' && A.errors.length === 0 && A.m.ctx === A.m.mainCtx, 'リプレイ中の描画: ' + A.errors[0]);
    ok(A.m.shakeKey('v') && A.m.SHAKE.on === false && A.m.shakeKey(']') && A.m.SHAKE.gain === 1.25 && !A.m.shakeKey('x'), '設定キー');
  }
  // ラボのパッドがどの時刻でも安全か（時刻を回して確かめる）
  let padBad = 0; m.LAB.rooms.forEach((r, ri) => { const pads = [ri ? m.LAB.rooms[ri - 1].exit : m.LAB.start, r.exit, ...r.cps]; for (let t = 0; t < 30; t += 0.05){ const ps = m.prims(r, t); for (const p of pads) for (let a = -1; a < 16; a++){ const x = p.x + (a < 0 ? 0 : Math.cos(a / 16 * 6.2832) * m.T.PAD_R), y = p.y + (a < 0 ? 0 : Math.sin(a / 16 * 6.2832) * m.T.PAD_R); for (const pr of ps) if (m.hit(pr, x, y, x, y, m.T.HEAD_R)) padBad++; } } });
  ok(padBad === 0, `ラボのパッドに障害物が ${padBad} 回かかった`);

  console.log(fail ? `SHAKE FAIL ${fail}` : 'SHAKE OK');
  process.exit(fail ? 1 : 0);
})();
