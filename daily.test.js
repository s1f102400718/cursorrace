// デイリー一式のテスト（node daily.test.js [日数=120]）
//  1) 生成が決定的か／指定日数ぶん予備部屋なしで作れるか／パッドがどの時刻でも安全か
//  2) ゴースト圧縮の往復
//  3) BOT の経路を「本物のゲームループ」に流して死なずに完走するか（ソルバーと当たり判定の食い違い検出）
//  4) 完走後: 記録保存 → 結果 → リプレイ → ランキング画面 → ゴースト並走 が例外なく回るか
const { load } = require('./harness.js');
const DAYS = +(process.argv[2] || 120), FROM = '2026-11-23';
let fail = 0; const ok = (c, msg) => { if (!c){ fail++; console.log('  NG', msg); } return c; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const names = ['COURSES', 'T', 'SV', 'DAILY', 'DAILIES', 'BOARD', 'NET', 'WATCH', 'ME', 'prims', 'hit', 'solveRoom', 'padSafe', 'buildDaily', 'ensureDaily', 'dayShift', 'dayNum', 'dayKeyAt', 'today', 'encodeGhost', 'decodeGhost',
    'openDaily', 'openBoard', 'play', 'update', 'samples', 'clicks', 'ups', 'boardKey', 'boardRows', 'loadRec', 'toggleSel', 'boardAct', 'watchLast', 'watchKey', 'endWatch', 'shareText', 'streak', 'restart',
    'state', 'deaths', 'finalTime', 'raceGhosts', 'lastRun', 'course', 'roomIdx'];
  const { m, clock, store, errors } = load(names);

  // ---- 1) 生成
  console.log(`1) 生成 ${DAYS}日ぶん`);
  const a = m.buildDaily(FROM), b = m.buildDaily(FROM), c2 = m.buildDaily(m.dayShift(FROM, 1));
  ok(a.key === b.key && JSON.stringify(a.rooms) === JSON.stringify(b.rooms), '同じ日付で同じコースにならない');
  ok(a.key !== c2.key, '別の日付で同じコースになった');
  ok(m.dayNum(FROM) === 1 && m.dayNum('2026-12-01') === 9, '日数の数え方');
  ok(m.dayKeyAt(Date.UTC(2026, 10, 23, 14, 59)) === '2026-11-23' && m.dayKeyAt(Date.UTC(2026, 10, 23, 15, 0)) === '2026-11-24', 'JST 0:00 で日付が替わらない');
  let fb = 0, padBad = 0, slow = 0, parMin = 1e9, parMax = 0; const courses = [];
  for (let i = 0; i < DAYS; i++){
    const date = m.dayShift(FROM, i), s = Date.now(), c = m.buildDaily(date); slow = Math.max(slow, Date.now() - s);
    fb += c.daily.fallbacks; parMin = Math.min(parMin, c.par); parMax = Math.max(parMax, c.par); if (i < 40) courses.push(c);
    ok(c.rooms.length === m.DAILY.ROOMS && c.medals[0] < c.medals[1] && c.medals[1] < c.medals[2], date + ' 形がおかしい');
    // パッドの安全を、生成時とは別の方法（時刻を回して実際の当たり判定）で確かめる
    c.rooms.forEach((room, ri) => { const pads = [ri ? c.rooms[ri - 1].exit : c.start, room.exit, ...room.cps];
      for (let t = 0; t < 24; t += 0.05){ const ps = m.prims(room, t); for (const p of pads) for (const pr of ps) if (m.hit(pr, p.x, p.y, p.x, p.y, m.T.PAD_R)) padBad++; } });
  }
  ok(fb === 0, `予備部屋が ${fb} 回出た`); ok(padBad === 0, `パッドに障害物が ${padBad} 回かかった`);
  console.log(`   予備部屋 ${fb} / パッド接触 ${padBad} / 最大生成時間 ${slow}ms / BOTパー ${parMin.toFixed(1)}〜${parMax.toFixed(1)}s`);

  // ---- 2) ゴースト圧縮
  console.log('2) ゴースト圧縮');
  const enc = m.encodeGhost(a.bot, a.par * 1000), dec = m.decodeGhost(enc);
  ok(dec && dec.length % 5 === 0 && dec.length > 50, 'デコードできない');
  ok(dec[dec.length - 4] === m.DAILY.ROOMS - 1, '最後の部屋まで記録されていない');
  let maxErr = 0; for (let i = 0; i < dec.length; i += 5){ let j = 0; while (j + 5 < a.bot.length && a.bot[j + 5] <= dec[i]) j += 5; if (a.bot[j + 1] === dec[i + 1]) maxErr = Math.max(maxErr, Math.hypot(a.bot[j + 2] - dec[i + 2], a.bot[j + 3] - dec[i + 3])); }
  ok(maxErr < 26, `位置のずれが大きい ${maxErr.toFixed(1)}px`);
  ok(m.decodeGhost('!!!') === null && m.decodeGhost('AAAA') === null, '壊れたデータを弾けない');
  console.log(`   ${a.bot.length / 5}点 → ${enc.length}文字 / 往復の最大ずれ ${maxErr.toFixed(1)}px`);

  // ---- 3) BOT を本物のゲームループに流す
  console.log(`3) BOT完走（デイリー${courses.length}日ぶん＋固定3コース）`);
  const runBot = (course, bot, open) => {
    open(); ok(m.state === 'board', 'ランキング画面にならない: ' + m.state);
    clock.t += 16; m.update(clock.t);
    m.play(); ok(m.state === 'title', 'タイトルにならない');
    m.samples.push({ x: bot[2], y: bot[3] }); clock.t += 16; m.update(clock.t); ok(m.state === 'count', 'カウントダウンにならない: ' + m.state);
    for (let i = 0; i < 400 && m.state === 'count'; i++){ clock.t += 16; m.update(clock.t); }
    ok(m.state === 'race', 'GO しない'); const t0 = clock.t; let last = -1;
    for (let i = 0; i < bot.length && (m.state === 'race'); i += 5){ if (bot[i] === last) continue; last = bot[i]; clock.t = t0 + bot[i]; m.samples.push({ x: bot[i + 2], y: bot[i + 3] }); m.update(clock.t); }
    return { done: m.state === 'done', deaths: m.deaths, time: m.finalTime, room: m.roomIdx };
  };
  let died = 0;
  for (const c of courses){
    m.DAILIES.set(c.daily.date, { ...c, bot: m.decodeGhost(m.encodeGhost(c.bot, c.par * 1000)) });
    const r = runBot(c, c.bot, () => m.openDaily(c.daily.date));
    if (!ok(r.done && r.deaths === 0 && Math.abs(r.time - c.par) < 0.2, `${c.daily.date} BOT失敗 done=${r.done} deaths=${r.deaths} room=${r.room} (${c.rooms[r.room].name}) time=${r.time} par=${c.par}`)) died++;
  }
  for (const c of m.COURSES){
    const bot = []; let t = 0, pos = c.start;
    c.rooms.forEach((room, i) => { const s = m.solveRoom(room, pos, room.exit, t, true, 40); for (const p of s.path) bot.push(Math.round(p.t * 1000), i, p.x, p.y, 1); t += s.time; pos = s.path[s.path.length - 1]; });
    const r = runBot(c, bot, () => m.openBoard(c));
    if (!ok(r.done && r.deaths === 0, `${c.name} BOT失敗 done=${r.done} deaths=${r.deaths} room=${r.room}`)) died++;
  }
  console.log(`   失敗 ${died}`);

  // ---- 4) 完走後の画面遷移
  console.log('4) 記録 → リプレイ → ランキング → 並走');
  const c = { ...courses[0], bot: m.decodeGhost(m.encodeGhost(courses[0].bot, courses[0].par * 1000)) }; m.DAILIES.set(c.daily.date, c);
  for (const k of [...store.keys()]) if (k.startsWith('cursorrun.rec.')) store.delete(k);
  const fresh = load(names, { store }); const g = fresh.m, gc = fresh.clock;
  g.DAILIES.set(c.daily.date, c);
  g.openDaily(c.daily.date); gc.t += 16; g.update(gc.t);
  ok(g.boardRows(c).length === 1 && g.boardRows(c)[0].bot, '走る前の表は BOT だけのはず');
  g.play(); g.samples.push({ x: c.bot[2], y: c.bot[3] }); gc.t += 16; g.update(gc.t);
  for (let i = 0; i < 400 && g.state === 'count'; i++){ gc.t += 16; g.update(gc.t); }
  { const bot = courses[0].bot, t0 = gc.t; let last = -1; for (let i = 0; i < bot.length && g.state === 'race'; i += 5){ if (bot[i] === last) continue; last = bot[i]; gc.t = t0 + bot[i]; g.samples.push({ x: bot[i + 2], y: bot[i + 3] }); g.update(gc.t); } }
  ok(g.state === 'done', '完走しない');
  const rec = g.loadRec(g.boardKey(c));
  ok(rec && Math.abs(rec.t - c.par * 1000) < 200 && rec.d === 0 && rec.rd.length === 5, '記録が保存されない');
  ok(store.has('cursorrun.rec.' + c.key), '端末に保存されない');
  const mine = g.decodeGhost(rec.g); ok(mine && mine[mine.length - 4] === 4, '自分のゴーストが最後の部屋まで無い');
  const rows = g.boardRows(c); ok(rows.length === 2 && rows[0].me && rows[0].rank === 1 && rows[1].bot, '表が 自分＋BOT にならない');
  ok(g.streak(c.daily.date) === 1, '連続日数が 1 にならない');
  const share = g.shareText(c, rec); ok(/DAILY #1/.test(share) && share.includes('🟩🟩🟩🟩🟩'), '共有文: ' + share);
  g.watchLast(); ok(g.state === 'watch', 'リプレイに入らない');
  for (let i = 0; i < 30; i++){ gc.t += 16; g.update(gc.t); }
  ok(g.WATCH.t > 0.3, 'リプレイが進まない');
  g.watchKey('arrowright', { shiftKey: true, preventDefault(){} }); g.watchKey(' ', { preventDefault(){} }); const tp = g.WATCH.t; gc.t += 16; g.update(gc.t); ok(g.WATCH.t === tp && tp > 5, '一時停止・早送りが効かない');
  g.watchKey('3', {}); g.watchKey(' ', { preventDefault(){} }); for (let i = 0; i < 2000 && g.WATCH.playing; i++){ gc.t += 16; g.update(gc.t); } ok(!g.WATCH.playing && Math.abs(g.WATCH.t - g.WATCH.dur) < 1e-6, '最後で止まらない');
  g.endWatch(); ok(g.state === 'done', 'リプレイから結果に戻らない');
  g.openBoard(c); for (let i = 0; i < 5; i++){ gc.t += 16; g.update(gc.t); }
  g.toggleSel(c, g.boardRows(c)[1]); gc.t += 16; g.update(gc.t);
  g.boardAct('watch'); ok(g.state === 'watch' && g.WATCH.list.length === 2, 'ランキングからのリプレイ（BOT＋自分）: ' + g.state + ' ' + g.WATCH.list.length);
  for (let i = 0; i < 10; i++){ gc.t += 16; g.update(gc.t); }
  g.watchKey('b', {}); ok(g.state === 'board', 'ランキングに戻らない');
  g.play(); ok(g.raceGhosts.length === 2, '並走ゴーストが 自己ベスト＋BOT にならない: ' + g.raceGhosts.length);
  g.samples.push({ x: c.bot[2], y: c.bot[3] }); gc.t += 16; g.update(gc.t); for (let i = 0; i < 300; i++){ gc.t += 16; g.update(gc.t); }
  ok(g.state === 'race', 'ゴースト付きで走れない: ' + g.state);
  ok(errors.length === 0 && fresh.errors.length === 0, '例外: ' + errors.concat(fresh.errors).slice(0, 3).join('\n'));

  await sleep(50);
  console.log(fail ? `DAILY FAIL ${fail}` : 'DAILY OK');
  process.exit(fail ? 1 : 0);
})();
