// ランキング共有のテスト（node board.test.js）
//  A) server.js の API を直接たたく: 登録・更新・名前変更・他人の上書き拒否・壊れたデータ拒否・過去のデイリー拒否・再起動後も残る
//  B) ゲーム2人ぶんを本物のサーバーにつなぐ: 1人が完走 → もう1人の表に出る → ゴーストを取って並走できる
//  C) 公開アーティファクトの共有DB（window.claude の代用品）でも同じ流れが回る
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const { load } = require('./harness.js');
const PORT = 8125, BASE = `http://localhost:${PORT}/`, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorrun-'));
let fail = 0; const ok = (c, msg) => { if (!c){ fail++; console.log('  NG', msg); } return c; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const realFetch = global.fetch, api = (u, init) => realFetch(BASE + u, init);
const post = (key, body) => api('api/board/' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
function startServer(){ return new Promise(res => { const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] }); p.stdout.on('data', d => { if (String(d).includes('server:')) res(p); }); }); }
const NAMES = ['COURSES', 'DAILIES', 'BOARD', 'NET', 'WATCH', 'ME', 'buildDaily', 'today', 'encodeGhost', 'decodeGhost', 'openDaily', 'openBoard', 'play', 'update', 'samples', 'boardKey', 'boardRows', 'loadRec', 'ghostFor', 'boardAct', 'toggleSel', 'setName', 'syncRec', 'state', 'raceGhosts', 'course'];
// BOT の経路でコースを完走させる
function finishRun(g, clock, course, raw){
  g.DAILIES.set(course.daily.date, course); g.openDaily(course.daily.date); clock.t += 16; g.update(clock.t);
  g.play(); g.samples.push({ x: raw[2], y: raw[3] }); clock.t += 16; g.update(clock.t);
  for (let i = 0; i < 400 && g.state === 'count'; i++){ clock.t += 16; g.update(clock.t); }
  const t0 = clock.t; let last = -1;
  for (let i = 0; i < raw.length && g.state === 'race'; i += 5){ if (raw[i] === last) continue; last = raw[i]; clock.t = t0 + raw[i]; g.samples.push({ x: raw[i + 2], y: raw[i + 3] }); g.update(clock.t); }
  return g.state === 'done';
}
const pump = async (g, clock, n = 12) => { for (let i = 0; i < n; i++){ await sleep(25); clock.t += 16; g.update(clock.t); } };

(async () => {
  let srv = await startServer();
  const W = { wall: Date.now() }; // サーバーは実時刻で「今日」を決めるので、ゲーム側も実時刻に合わせる
  const base = load(NAMES, W), today = base.m.today(), raw = base.m.buildDaily(today), bot = raw.bot;
  const course = { ...raw, bot: base.m.decodeGhost(base.m.encodeGhost(raw.bot, raw.par * 1000)) }, key = course.key;
  const g1 = base.m.encodeGhost(bot, 20000), g2 = base.m.encodeGhost(bot, 15000);

  console.log('A) API');
  ok((await (await api('api/ping')).json()).cursorrun === 1, 'ping');
  ok((await (await api('api/board/' + key)).json()).rows.length === 0, '最初は空');
  let r = await post(key, { pid: 'p-aaaaaa', token: 'tokentoken-a', name: 'Aさん', t: 20000, d: 3, g: g1 });
  ok(r.ok && r.rows.length === 1 && r.rows[0].t === 20000 && r.rows[0].name === 'Aさん', '登録: ' + JSON.stringify(r).slice(0, 120));
  r = await post(key, { pid: 'p-bbbbbb', token: 'tokentoken-b', name: 'B', t: 15000, d: 0, g: g2 });
  ok(r.ok && r.rows.length === 2 && r.rows[0].pid === 'p-bbbbbb', '速い順に並ぶ');
  r = await post(key, { pid: 'p-aaaaaa', token: 'tokentoken-a', name: 'Aさん', t: 25000, d: 0, g: base.m.encodeGhost(bot, 25000) });
  ok(r.ok && r.rows.find(x => x.pid === 'p-aaaaaa').t === 20000, '遅い記録では上書きされない');
  r = await post(key, { pid: 'p-aaaaaa', token: 'tokentoken-a', name: '改名', t: 25000, d: 0, g: base.m.encodeGhost(bot, 25000) });
  ok(r.ok && r.rows.find(x => x.pid === 'p-aaaaaa').name === '改名' && r.rows.find(x => x.pid === 'p-aaaaaa').t === 20000, '名前だけ変えられる');
  r = await post(key, { pid: 'p-aaaaaa', token: 'someone-else', name: 'X', t: 1000, d: 0, g: base.m.encodeGhost(bot, 1000) });
  ok(!r.ok && r.rows === undefined, '合言葉が違えば他人の記録は上書きできない');
  r = await post(key, { pid: 'p-cccccc', token: 'tokentoken-c', name: 'C', t: 15000, d: 0, g: 'not base64 !!' }); ok(!r.ok, '壊れたゴーストは拒否');
  r = await post(key, { pid: 'p-cccccc', token: 'tokentoken-c', name: 'C', t: 5000, d: 0, g: g2 }); ok(!r.ok, 'タイムとゴーストの長さが合わなければ拒否');
  r = await post(key, { pid: 'p-cccccc', token: 'tokentoken-c', name: '', t: 15000, d: 0, g: g2 }); ok(!r.ok, '名前なしは拒否');
  r = await post('d-2020-01-01-g1-deadbeef', { pid: 'p-cccccc', token: 'tokentoken-c', name: 'C', t: 15000, d: 0, g: g2 }); ok(!r.ok && /受付/.test(r.err), '過去のデイリーは拒否');
  r = await post('c-normal-v0_2', { pid: 'p-cccccc', token: 'tokentoken-c', name: 'C', t: 15000, d: 0, g: g2 }); ok(r.ok, '固定コースはいつでも登録できる');
  const gh = await (await api(`api/ghost/${key}/p-bbbbbb`)).json(); ok(gh.g === g2, 'ゴーストが取れる');
  ok((await api(`api/ghost/${key}/p-zzzzzz`)).status === 404, '無いゴーストは 404');
  ok((await api('data/boards/' + key + '.json')).status === 404, '保存ファイルは配信しない');
  ok((await api('index.html')).status === 200, 'ゲーム本体は配信する');
  srv.kill(); await sleep(300); srv = await startServer();
  ok((await (await api('api/board/' + key)).json()).rows.length === 2, '再起動しても残る');

  console.log('B) ゲーム2人 ↔ サーバー');
  const web = { ...W, location: { protocol: 'http:', host: 'localhost:' + PORT, search: '', origin: BASE.slice(0, -1), pathname: '/' }, fetch: api };
  const P1 = load(NAMES, web); P1.m.setName('ねこ'); await sleep(200);
  ok(P1.m.NET.mode === 'api', 'サーバーを見つけられない: ' + P1.m.NET.mode);
  ok(finishRun(P1.m, P1.clock, course, bot), 'P1 が完走しない'); await pump(P1.m, P1.clock);
  let rows = (await (await api('api/board/' + key)).json()).rows;
  ok(rows.length === 3 && rows[0].name === 'ねこ' && Math.abs(rows[0].t - course.par * 1000) < 200, 'P1 の記録がサーバーに無い: ' + JSON.stringify(rows.map(x => [x.name, x.t])));
  ok(P1.m.loadRec(key).sent.startsWith('api|'), '送信済みの印が付かない');
  const P2 = load(NAMES, web); P2.m.setName('いぬ'); await sleep(200);
  P2.m.DAILIES.set(today, course); P2.m.openDaily(today); await pump(P2.m, P2.clock);
  rows = P2.m.boardRows(course);
  ok(rows.length === 4 && rows[0].name === 'ねこ' && !rows[0].me && rows[3].bot, 'P2 の表: ' + JSON.stringify(rows.map(x => x.name)));
  P2.m.toggleSel(course, rows[0]); await pump(P2.m, P2.clock);
  const s = P2.m.ghostFor(course, rows[0]); ok(s && s.length > 100 && s[s.length - 4] === 4, 'P1 のゴーストを取れない');
  P2.m.play(); ok(P2.m.raceGhosts.length === 1 && P2.m.raceGhosts[0].name === 'ねこ', 'P1 のゴーストが並走に入らない');
  P2.m.openBoard(course); P2.m.boardAct('watch'); ok(P2.m.state === 'watch' && P2.m.WATCH.list[0].name === 'ねこ', 'P1 の走りを再生できない');
  // P1 が改名 → サーバーの名前も変わる
  P1.m.openBoard(course); P1.m.setName('とら'); P1.m.syncRec(course); await pump(P1.m, P1.clock);
  ok((await (await api('api/board/' + key)).json()).rows[0].name === 'とら', '改名がサーバーに届かない');
  ok(P1.errors.length === 0 && P2.errors.length === 0, '例外: ' + P1.errors.concat(P2.errors).slice(0, 3).join('\n'));
  srv.kill();

  console.log('C) 共有DB（アーティファクト）');
  // window.claude の代用品: 文書をメモリに持ち、購読者へ変更を配る。uid ごとに「自分の文書しか書けない」規則も再現する
  const docs = new Map(), subs = new Set();
  const fire = () => { for (const f of subs) f(); };
  const fakeClaude = uid => ({ use: async name => name === 'user' ? { id: async () => uid } : name !== 'db' ? null : {
    doc: p => ({
      get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
      set: async v => { if (!uid || p.split('/')[1] !== uid) throw { code: 'invalid_argument' }; docs.set(p, JSON.parse(JSON.stringify(v))); fire(); },
      delete: async () => { docs.delete(p); fire(); } }),
    collection: p => ({ limit(){ return this; }, onSnapshot(next){ const f = () => next({ docs: [...docs.entries()].filter(([k]) => k.startsWith(p + '/') && k.split('/').length === 2).map(([k, v]) => ({ id: k.split('/')[1], data: () => v })) }); subs.add(f); setTimeout(f, 0); return () => subs.delete(f); } }),
  } });
  const D1 = load(NAMES, { ...W, claude: fakeClaude('u_one') }); D1.m.setName('ひよこ'); await sleep(50);
  ok(D1.m.NET.mode === 'db' && D1.m.NET.uid === 'u_one', '共有DBを使えていない: ' + D1.m.NET.mode);
  ok(finishRun(D1.m, D1.clock, course, bot), 'D1 が完走しない'); await pump(D1.m, D1.clock);
  const mine = docs.get('scores/u_one'); ok(mine && mine.name === 'ひよこ' && mine.runs[key] && docs.has('scores/u_one/g/' + key), '自分の文書とゴーストが書かれない: ' + [...docs.keys()]);
  const D2 = load(NAMES, { ...W, claude: fakeClaude('u_two') }); D2.m.setName('うま'); await sleep(50);
  D2.m.DAILIES.set(today, course); D2.m.openDaily(today); await pump(D2.m, D2.clock);
  rows = D2.m.boardRows(course); ok(rows.length === 2 && rows[0].name === 'ひよこ' && !rows[0].me, 'D2 の表: ' + JSON.stringify(rows.map(x => x.name)));
  D2.m.toggleSel(course, rows[0]); await pump(D2.m, D2.clock);
  const s2 = D2.m.ghostFor(course, rows[0]); ok(s2 && s2.length > 100, 'D1 のゴーストを取れない');
  // 書けない人（閲覧のみ）: 自分の記録は端末に残り、表は読める
  const D3 = load(NAMES, { ...W, claude: fakeClaude(null) }); await sleep(50);
  ok(D3.m.NET.mode === 'db' && D3.m.NET.canWrite === false, '閲覧のみの判定');
  ok(finishRun(D3.m, D3.clock, course, bot), 'D3 が完走しない'); await pump(D3.m, D3.clock);
  rows = D3.m.boardRows(course); ok(rows.length === 3 && rows.some(x => x.me && x.local) && !docs.has('scores/' + D3.m.ME.pid), '閲覧のみの人の表: ' + JSON.stringify(rows.map(x => [x.name, !!x.local])));
  ok(D1.errors.length + D2.errors.length + D3.errors.length === 0, '例外: ' + D1.errors.concat(D2.errors, D3.errors).slice(0, 3).join('\n'));

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `BOARD FAIL ${fail}` : 'BOARD OK');
  process.exit(fail ? 1 : 0);
})();
