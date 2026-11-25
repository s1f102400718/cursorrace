// 第2弾の要素のテスト（node elements.test.js）
//  1) 既に遊ばれた日のデイリーが変わっていない（識別子を固定値と比べる）／版が日付で切り替わる
//  2) 新しい当たり判定: 回る輪（すき間）・浸水（島）・透明壁・偽装壁・跳ね返り
//  3) ラボの全要素: BOTが解ける／パッドが安全／本物のゲームループで死なずに完走／同じ時刻なら同じ絵（状態を持たない）
//  4) マルチの箱に入れる形（設置の検証が通る）
//  5) g3 のデイリー: 新しい型と上乗せが実際に出る
const { load, botPath, runBot, RIM } = require('./harness.js');
let fail = 0; const ok = (c, msg) => { if (!c){ fail++; console.log('  NG', msg); } return c; };
const NAMES = ['T', 'LABS', 'ARCH', 'MODS', 'ARCH_SINCE', 'MOD_SINCE', 'prims', 'hit', 'sweepHit', 'solveRoom', 'padSafe', 'bounds', 'materialize', 'placementOk', 'translate', 'fold', 'buildDaily', 'genVer', 'dayShift', 'roomLabel',
  'openLab', 'openLabList', 'update', 'samples', 'clicks', 'state', 'deaths', 'course', 'ctx', 'mainCtx', 'lightProj', 'lightDir'];

(() => {
  const { m } = load(NAMES);

  console.log('1) 版と、遊ばれた日のコース');
  ok(m.genVer('2026-11-23') === 'g2' && m.genVer('2026-11-24') === 'g2' && m.genVer('2026-11-25') === 'g3' && m.genVer('2027-05-01') === 'g3', '版の切り替え日');
  const GOLD = { '2026-11-23': 'd-2026-11-23-g2-f5eb32d8', '2026-11-24': 'd-2026-11-24-g2-f2e59b04' }; // この2日は公開後に遊ばれている。変えない
  for (const d in GOLD){ const k = m.buildDaily(d).key; ok(k === GOLD[d], `${d} のコースが変わった: ${k}（元 ${GOLD[d]}）`); }

  console.log('2) 当たり判定');
  const at = (pieces, t, x, y) => !!m.sweepHit(m.prims({ pieces }, t), x, y, x, y);
  const ring = [{ t: 'ringwall', x: 640, y: 360, R: 200, thick: 18, n: 2, gap: 60, rpm: 0, phase: 0 }]; // すき間は 0〜60° と 180〜240°
  ok(!at(ring, 0, 640 + 200 * Math.cos(0.5), 360 + 200 * Math.sin(0.5)), 'すき間の中で当たる');
  ok(at(ring, 0, 640 + 200 * Math.cos(2), 360 + 200 * Math.sin(2)), '輪の上（すき間の外）で当たらない');
  ok(!at(ring, 0, 640, 360) && !at(ring, 0, 640 + 240, 360 + 120), '輪の内側・外側で当たる');
  ok(!!m.sweepHit(m.prims({ pieces: ring }, 0), 640 - 150, 360 + 40, 640 - 250, 360 + 40), '輪を1コマで飛び越えられる（掃引で止まらない）');
  const ring2 = [{ ...ring[0], rpm: 30 }]; ok(at(ring2, 0.5, 640 + 200 * Math.cos(0.5), 360 + 200 * Math.sin(0.5)) && !at(ring2, 0.5, 640 + 200 * Math.cos(0.5 + Math.PI / 2), 360 + 200 * Math.sin(0.5 + Math.PI / 2)), '輪が回っていない');
  const flood = [{ t: 'flood', isl: [[300, 300, 80], [700, 400, 60]], period: 4, duty: 0.5, warn: 1, phase: 0 }];
  ok(at(flood, 1, 500, 300) && !at(flood, 1, 300, 300) && !at(flood, 1, 700, 430), '浸水中: 島の外で当たり、島の上では当たらない');
  ok(!at(flood, 3, 500, 300), '浸水していない時間に当たる');
  ok(at(flood, 1, 300, 378) && !at(flood, 1, 300, 374), '島の縁（カーソルの半径ぶん内側まで安全）');
  ok(at([{ t: 'ghostwall', x: 400, y: 100, w: 40, h: 300, reveal: 150 }], 0, 420, 200) && !at([{ t: 'fakewall', x: 400, y: 100, w: 40, h: 300 }], 0, 420, 200), '透明壁は当たり、偽装壁は当たらない');
  ok(m.fold(130, 0, 100) === 70 && m.fold(-30, 0, 100) === 30 && m.fold(250, 0, 100) === 50, '跳ね返りの計算');
  const ball = [{ t: 'ball', x: 300, y: 200, vx: 260, vy: 190, r: 30, box: [190, 20, 1090, 700] }]; let out = 0;
  for (let t = 0; t < 60; t += 0.07){ const b = m.prims({ pieces: ball }, t)[0]; if (b.x < 220 - 1e-6 || b.x > 1060 + 1e-6 || b.y < 50 - 1e-6 || b.y > 670 + 1e-6) out++; }
  ok(out === 0, `ボールが枠を出た ${out} 回`);
  ok(!m.padSafe(flood, { x: 500, y: 300 }, 50) && m.padSafe(flood, { x: 300, y: 300 }, 30) && !m.padSafe(flood, { x: 300, y: 300 }, 90), '浸水のパッド判定（島の上だけ安全）');
  ok(!m.padSafe(ring, { x: 840, y: 360 }, 50) && m.padSafe(ring, { x: 640, y: 360 }, 50) && m.padSafe(ring, { x: 1000, y: 360 }, 50), '輪のパッド判定');

  console.log(`3) ラボ ${m.LABS.length}要素`);
  let solved = 0;
  m.LABS.forEach((e, idx) => {
    const start = { x: 90, y: 360 }, b = botPath(m, e.rooms, start);
    if (!ok(!b.fail && b.fail !== 0, `${e.code} ${e.name}: BOTが部屋 ${b.fail + 1} を解けない`)) return;
    // パッドの安全（時刻を回して、パッドの中心と縁に置いたカーソルが当たらない）
    let padBad = 0; e.rooms.forEach((room, ri) => { const pads = [ri ? e.rooms[ri - 1].exit : start, room.exit, ...room.cps];
      for (let t = 0; t < 24; t += 0.05){ const ps = m.prims(room, t); for (const p of pads) for (const [ox, oy] of RIM){ const x = p.x + ox * m.T.PAD_R, y = p.y + oy * m.T.PAD_R; for (const pr of ps) if (m.hit(pr, x, y, x, y, m.T.HEAD_R)) padBad++; } } });
    ok(padBad === 0, `${e.code} ${e.name}: パッドに障害物が ${padBad} 回かかった`);
    // 同じ時刻なら同じ絵
    ok(JSON.stringify(m.prims(e.rooms[0], 3.21).map(p => [p.k, p.x, p.y, p.a0, p.on])) === JSON.stringify(m.prims(e.rooms[0], 3.21).map(p => [p.k, p.x, p.y, p.a0, p.on])), `${e.code}: 時刻だけで決まっていない`);
    // 本物のゲームループで完走
    const G = load(NAMES); G.m.openLabList(); G.clock.t += 16; G.m.update(G.clock.t); ok(G.m.state === 'lab', 'ラボの一覧が開かない');
    G.m.openLab(idx); const done = runBot(G.m, G.clock, b.bot);
    if (ok(done && G.m.deaths === 0, `${e.code} ${e.name}: 実ゲームで完走しない（state ${G.m.state}, deaths ${G.m.deaths}）`)) solved++;
    ok(G.errors.length === 0 && G.m.ctx === G.m.mainCtx, `${e.code}: 描画で例外 ${G.errors[0]}`);
  });
  console.log(`   完走 ${solved} / ${m.LABS.length}`);

  console.log('4) マルチの箱');
  const S = { x: 90, y: 360 }, Gp = { x: 1190, y: 360 }, rels = [
    { t: 'danmaku', x: 0, y: 0, pattern: 'ring', n: 16, speed: 150, interval: 1, r: 6, spin: 7, life: 2.2 }, { t: 'burst', x: 0, y: 0, aim: 0, spin: 47, interval: 1.2, speed: 140, fuse: 1, m: 10, speed2: 160, life2: 1.2, r: 9, r2: 5 },
    { t: 'bounce', x: 0, y: 0, n: 5, speed: 200, interval: 2.2, r: 7, life: 4, spin: 20, box: [190, 20, 1090, 700] }, { t: 'ball', x: 0, y: 0, vx: 200, vy: 190, r: 28, box: [190, 20, 1090, 700] },
    { t: 'patrol', pts: [[-150, -100], [150, -100], [150, 100], [-150, 100]], speed: -300, w: 54, h: 54 }, { t: 'train', x: 0, y: 0, R: 130, cars: 5, size: 38, rpm: 24, spacing: 20 },
    { t: 'serpent', vert: true, x: 0, y: 0, amp: 80, wave: 360, speed: 260, segs: 13, gap: 24, r: 14 }, { t: 'breathe', x: 0, y: 0, w: 200, h: 320, period: 2, min: 0.15 },
    { t: 'seq', x: -160, y: -200, w: 320, h: 400, lines: 4, slot: 0.35, on: 0.28, thick: 10 }, { t: 'ringwall', x: 0, y: 0, R: 130, thick: 16, n: 2, gap: 60, rpm: 18 }];
  for (const rel of rels){ const p = m.materialize(rel, { x: 640, y: 360 }), b = p && m.bounds(p);
    ok(p && [b.x, b.y, b.w, b.h].every(Number.isFinite) && m.placementOk(p, S, Gp) && m.prims({ pieces: [p] }, 1.5).length > 0, `${rel.t}: 中央に置けない／絵が出ない`);
    if (['patrol', 'breathe', 'seq', 'train', 'ringwall'].includes(rel.t)) ok(!m.placementOk(m.materialize(rel, { x: 110, y: 360 }), S, Gp), `${rel.t}: スタートの上に置けてしまう`); }

  console.log('5) g3 のデイリー（30日ぶん）');
  const seenA = new Set(), seenM = new Set(); let fb = 0;
  for (let i = 0; i < 30; i++){ const c = m.buildDaily(m.dayShift('2026-11-25', i)); fb += c.daily.fallbacks; ok(c.daily.ver === 'g3', '版'); for (const r of c.rooms){ seenA.add(r.name); for (const k of r.mods || []) seenM.add(k); } }
  const newA = Object.keys(m.ARCH_SINCE).filter(k => seenA.has(k)), newM = Object.keys(m.MOD_SINCE).filter(k => seenM.has(k));
  ok(fb === 0, `予備部屋 ${fb}`); ok(newA.length >= 9, '新しい型がほとんど出ない: ' + newA); ok(newM.length >= 7, '新しい上乗せがほとんど出ない: ' + newM);
  console.log(`   新しい型 ${newA.length}/${Object.keys(m.ARCH_SINCE).length} 種、上乗せ ${newM.length}/${Object.keys(m.MOD_SINCE).length} 種が出た`);

  console.log('6) 立体表示（光源と影）');
  const Lg = m.T.LIGHT, sh = (x, y, h) => { const p = m.lightProj(x, y, h); return [p[0] - x, p[1] - y]; };
  ok(Lg.Y < 0 && Lg.X === m.T.W / 2, '光源がフィールドの外・中央の上に無い');
  const sl = sh(200, 400, 40), sr = sh(1080, 400, 40), sc = sh(640, 400, 40);
  ok(sl[0] < 0 && sl[1] > 0 && sr[0] > 0 && sr[1] > 0 && Math.abs(sc[0]) < 1e-9 && sc[1] > 0, '影が光源と反対の向き（左の物は左下、右の物は右下、真下の物は下）へ伸びない');
  ok(Math.hypot(...sh(200, 650, 40)) > Math.hypot(...sh(200, 100, 40)) && Math.hypot(...sh(200, 400, 60)) > Math.hypot(...sl), '影が 遠いほど・高いほど 長くならない');
  const d1 = m.lightDir(200, 600), d2 = m.lightDir(1080, 600); ok(d1[0] > 0 && d1[1] < 0 && d2[0] < 0 && d2[1] < 0, '光の当たる向き');
  // 立体表示は見た目だけ: 入/切で同じ入力から同じ結果になる
  const runLook = depth => { const G = load([...NAMES, 'LOOK', 'finalTime', 'lastRun']); G.m.LOOK.depth = depth; const e = G.m.LABS.findIndex(q => q.code === 'MV-4'), b = botPath(G.m, G.m.LABS[e].rooms, { x: 90, y: 360 }); G.m.openLab(e); const done = runBot(G.m, G.clock, b.bot); return { done, t: G.m.finalTime, d: G.m.deaths, rec: JSON.stringify(G.m.lastRun && G.m.lastRun.s), err: G.errors.length }; };
  const on = runLook(true), off = runLook(false);
  ok(on.done && off.done && on.t === off.t && on.d === 0 && off.d === 0 && on.rec === off.rec, '立体表示の入/切で結果が変わった');
  ok(on.err === 0 && off.err === 0, '立体表示の描画で例外');

  console.log(fail ? `ELEMENTS FAIL ${fail}` : 'ELEMENTS OK');
  process.exit(fail ? 1 : 0);
})();
