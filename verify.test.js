// 走りの検証のテスト（node verify.test.js）
//  1) コースの識別: 固定コースと当日のデイリーだけ通す。版や中身の違う識別子・でたらめな識別子は知らないコース
//  2) 本物の走りは通る: 固定コースと 14 日ぶんのデイリーの BOT、速い人を模した走り（BOT の道を 2〜4 倍速）、ゲーム本体が実際に保存した記録
//  3) 角を素早く回る走り（補間で壁の角を削る）を落とさない
//  4) 偽物は落ちる: 中身のないゴースト／スタートしていない／部屋を飛ばす／ゴールしていない／瞬間移動／速すぎる／長い壁の通り抜け／死亡数のごまかし
//  5) 重さ: 10分ぶんの走りと、わざと重くした記録でも 1 件あたりの時間が短い
const { load, botPath, runBot } = require('./harness.js');
const { courseFor, dailyFor, verifyRun, V } = require('./verify.js');
let fail = 0; const ok = (c, msg) => { if (!c){ fail++; console.log('  NG', msg); } return c; };
const { m, clock } = load(['T', 'COURSES', 'boardKey', 'solveRoom', 'encodeGhost', 'decodeGhost', 'openBoard', 'play', 'update', 'samples', 'state', 'loadRec', 'deaths'], { wall: Date.now() });
const enc = (s, ms) => m.encodeGhost(s, ms);
const scale = (bot, k) => bot.map((v, i) => i % 5 === 0 ? Math.round(v / k) : v); // 同じ道を k 倍の速さで

(() => {
  console.log('1) コースの識別');
  const today = new Date(Date.now() + 540 * 60000).toISOString().slice(0, 10), daily = dailyFor(today);
  ok(m.COURSES.every(c => courseFor(m.boardKey(c))), '固定コースを知らない');
  ok(daily && courseFor(daily.key) === daily, '当日のデイリーを知らない');
  ok(courseFor(daily.key.replace(/-g\d+-/, '-g1-')) === null && courseFor(daily.key.slice(0, -1) + (daily.key.slice(-1) === '0' ? '1' : '0')) === null, '版や中身の違う識別子を通した');
  ok(courseFor('d-2020-01-01-g3-00000000') === null && courseFor('d-9999-99-99-g3-00000000') === null && courseFor('x-anything') === null && courseFor('c-normal-v9_9') === null, 'でたらめな識別子を通した');

  console.log('2) 本物の走り');
  const bots = [];
  for (const c of m.COURSES){ const b = botPath(m, c.rooms, c.start); if (ok(b.fail === undefined, c.name + ' を BOT が解けない')) bots.push({ c, bot: b.bot, t: Math.round(b.time * 1000) }); }
  let dates = 0;
  for (let i = 0; i < 14; i++){ const date = new Date(Date.parse(today) + i * 86400000).toISOString().slice(0, 10), c = dailyFor(date); if (c){ dates++; bots.push({ c, bot: c.bot, t: Math.round(c.par * 1000) }); } }
  ok(dates === 14, 'デイリーを作れない日がある');
  let pass = 0, sus = 0, fastPass = 0, fastN = 0, fastSus = 0;
  for (const { c, bot, t } of bots){
    const v = verifyRun(c, enc(bot, t), t, 0); if (ok(v.ok, `${c.name} の BOT が落ちた: ${v.why}`)){ pass++; sus += v.sus; }
    for (const k of [2, 3, 4]){ fastN++; const tt = Math.round(t / k), f = verifyRun(c, enc(scale(bot, k), tt), tt, 0); if (ok(f.ok, `${c.name} の ${k} 倍速が落ちた: ${f.why}`)){ fastPass++; fastSus += f.sus; } }
  }
  ok(sus === 0, `障害物どおりに走った BOT で、めり込みを数えた: ${sus}`);
  console.log(`   BOT ${pass}/${bots.length} 本 通過（めり込み ${sus}）· 2〜4倍速 ${fastPass}/${fastN} 本 通過（障害物の時刻がずれるので、めり込みは ${fastSus} 回数えた）`);
  // ゲーム本体が保存した記録
  { const c = m.COURSES[0], b = bots[0]; m.openBoard(c); m.play(); const done = runBot(m, clock, b.bot), rec = m.loadRec(m.boardKey(c));
    if (ok(done && rec, 'ゲーム本体で完走しない')){ const v = verifyRun(c, rec.g, rec.t, rec.d); ok(v.ok && v.sus === 0, 'ゲーム本体が保存した記録が落ちた: ' + v.why); } }

  console.log('3) 角を素早く回る走り');
  // 壁1枚（x 600〜640, y 0〜400）の下の端を、3000px/s で左から右へ回り込む。30Hz だと角を 100px 単位で削る
  const room = { exit: { x: 1190, y: 360 }, cps: [], pieces: [{ t: 'wall', x: 600, y: 0, w: 40, h: 400 }] }, course = { start: { x: 90, y: 360 }, rooms: [room] };
  const pathRun = (pts, speed, dead) => { const s = []; let t = 0; for (let i = 0; i < pts.length; i++){ if (i) t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) / speed * 1000; s.push(Math.round(t), 0, pts[i][0], pts[i][1], dead && dead(i) ? 0 : 1); } return { s, t: Math.max(500, Math.round(t)) }; };
  for (const speed of [1500, 3000, 6000]){
    const r = pathRun([[90, 360], [560, 360], [590, 430], [620, 440], [650, 430], [680, 360], [1190, 360]], speed); if (r.t < 500) continue;
    const v = verifyRun(course, enc(r.s, r.t), r.t, 0); ok(v.ok, `角を ${speed}px/s で回る走りが落ちた: ${v.why}`);
  }
  // 壁の先端のすぐ下を往復する（ヘアピン）
  { const r = pathRun([[90, 360], [570, 360], [570, 420], [670, 420], [670, 360], [1190, 360]], 2500), v = verifyRun(course, enc(r.s, r.t), r.t, 0); ok(v.ok, 'ヘアピンが落ちた: ' + v.why); }

  console.log('4) 偽物');
  const c0 = bots[0].c, b0 = bots[0].bot, t0 = bots[0].t, why = (g, t, d) => { const v = verifyRun(c0, g, t, d === undefined ? 0 : d); return v.ok ? 'ok' : v.why; };
  const zero = Buffer.alloc(4 + 300 * 3); zero[0] = 1; zero[1] = 30; zero[2] = 300 & 255; zero[3] = 300 >> 8;
  ok(why(zero.toString('base64'), 10000) !== 'ok', '中身のないゴーストが通った');
  ok(why('!!!!', 10000) !== 'ok' && why('', 10000) !== 'ok', '壊れたゴーストが通った');
  const noStart = b0.slice(); noStart[2] = 640; noStart[3] = 360; ok(/スタート/.test(why(enc(noStart, t0), t0)), 'スタートパッドの外から始めた走りが通った: ' + why(enc(noStart, t0), t0));
  const lastRoom = c0.rooms.length - 1, oneRoom = b0.filter((v, i) => b0[i - i % 5 + 1] === 0); ok(/ゴール/.test(why(enc(oneRoom, oneRoom[oneRoom.length - 5]), oneRoom[oneRoom.length - 5])), '最初の部屋だけの走りが通った');
  const skip = b0.map((v, i) => i % 5 === 1 && v >= 1 ? lastRoom : v); ok(why(enc(skip, t0), t0) !== 'ok', '部屋を飛ばした走りが通った'); // 圧縮は「1つ進んだ」しか書けないので、飛ばした走りはゴールに届かない
  const tele = [0, 0, 90, 360, 1, 400, 0, 90, 360, 1, 433, 0, 1190, 300, 1, 900, 0, 1190, 360, 1]; ok(/瞬間移動|壁|ゴール/.test(why(enc(tele, 900), 900)), '瞬間移動が通った: ' + why(enc(tele, 900), 900));
  { const B = bots[1], k = 30, tt = Math.round(B.t / k), v = verifyRun(B.c, enc(scale(B.bot, k), tt), tt, 0); // BOT は 500px/s なので 30 倍 = 15000px/s
    ok(!v.ok, `${B.c.name} の ${k} 倍速（${tt}ms）が通った`); } // 理由は 速すぎる／瞬間移動／壁の通り抜け のどれか（先に見つかったもの）
  { const r = pathRun([[90, 360], [1190, 360], [90, 360], [1190, 360], [90, 360], [1190, 360]], 16000), v = verifyRun({ start: { x: 90, y: 360 }, rooms: [{ exit: { x: 1190, y: 360 }, cps: [], pieces: [] }] }, enc(r.s, r.t), r.t, 0);
    ok(!v.ok && /速すぎる/.test(v.why), '障害物のない部屋を 16000px/s で往復し続ける走りが通った: ' + (v.ok ? 'ok' : v.why)); }
  ok(why(enc(scale(b0, 40), Math.round(t0 / 40)), Math.round(t0 / 40)) !== 'ok', '0.5 秒未満のタイムが通った');
  ok(/タイム/.test(why(enc(b0, t0), Math.round(t0 / 3))) && /タイム/.test(why(enc(b0, t0), 400)), 'ゴーストより短いタイムの申告が通った');
  // 長い壁の通り抜け: 壁（y 0〜700 をふさぎ、下の端だけ開いている）の上のほうを、まっすぐ突っ切る
  const long = { start: { x: 90, y: 360 }, rooms: [{ exit: { x: 1190, y: 360 }, cps: [], pieces: [{ t: 'wall', x: 600, y: 0, w: 40, h: 640 }] }] };
  { const r = pathRun([[90, 360], [1190, 360]], 1500), v = verifyRun(long, enc(r.s, r.t), r.t, 0); ok(!v.ok && /壁/.test(v.why), '長い壁を突っ切った走りが通った: ' + (v.ok ? 'ok' : v.why)); }
  { const r = pathRun([[90, 360], [560, 360], [560, 680], [680, 680], [680, 360], [1190, 360]], 1500), v = verifyRun(long, enc(r.s, r.t), r.t, 0); ok(v.ok, '同じ壁を下からよけた走りが落ちた: ' + v.why); }
  // やられて戻る間は壁を通ってよい（判定のない幽霊）。ただし死亡数は合っていること
  { const r = pathRun([[90, 360], [560, 360], [570, 360], [90, 360], [90, 361], [560, 361], [560, 680], [680, 680], [680, 360], [1190, 360]], 1500, i => i === 2 || i === 3), g = enc(r.s, r.t);
    const v = verifyRun(long, g, r.t, 1); ok(v.ok && v.deaths === 1, '1回やられて戻った走りが落ちた: ' + v.why);
    ok(!verifyRun(long, g, r.t, 0).ok && !verifyRun(long, g, r.t, 9).ok, '死亡数のごまかしが通った'); }

  console.log('5) 重さ');
  { const c = bots[bots.length - 1].c, b = bots[bots.length - 1].bot, long10 = [];  // 10分ぶん: スタートパッドの中で待ち続けてから走る
    for (let ms = 0; ms < 590000; ms += 33) long10.push(ms, 0, c.start.x, c.start.y, 1);
    for (let i = 0; i < b.length; i += 5) long10.push(590000 + b[i], b[i + 1], b[i + 2], b[i + 3], 1);
    const tt = 590000 + Math.round(c.par * 1000), g = enc(long10, tt), a = Date.now(), v = verifyRun(c, g, tt, 0), ms = Date.now() - a;
    ok(v.ok, '10分の走りが落ちた: ' + v.why); ok(ms < 1500, `10分の走りの検証に ${ms}ms`);
    // わざと重く: 壁をまたぐ短い往復を何千回もくり返す
    const zig = []; for (let i = 0; i < 6000; i++) zig.push(i * 33, 0, i === 0 ? 90 : i % 2 ? 590 : 650, 360, 1);
    const a2 = Date.now(), v2 = verifyRun(long, enc(zig, 6000 * 33), 6000 * 33, 0), ms2 = Date.now() - a2;
    ok(!v2.ok, '壁をまたぐ往復が通った'); ok(ms2 < 1500, `わざと重くした記録の検証に ${ms2}ms`);
    console.log(`   10分の走り ${ms}ms · わざと重くした記録 ${ms2}ms（上限 ${V.DETOUR_BUDGET} 回）`);
  }

  console.log(fail ? `VERIFY FAIL ${fail}` : 'VERIFY OK');
  process.exit(fail ? 1 : 0);
})();
