// 外に公開したときの守りのテスト（node server.test.js）。本物のサーバーを立てて、外から来る相手のつもりでたたく
//  1) 配信: ゲーム本体だけ出す（設計書・テスト・サーバーのソース・記録の保存先は 404）。CSP と圧縮
//  2) 記録: 偽の記録・知らないコース・昨日のデイリーは断る／本物は載る／外に出す行に内部の項目（合言葉・sus）が混ざらない／でたらめな識別子でファイルを作らせない
//  3) 回数の上限: 送りすぎた相手だけ 429。別の相手は通る（相手は X-Forwarded-For で見分ける）
//  4) 管理用 API: 合言葉なしは 401。一覧に sus が出る。行を消せる
//  5) WebSocket: おかしなメッセージ・大きすぎるメッセージ・連打でサーバーが落ちない。接続数の上限
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const WebSocket = require('ws');
const { load, botPath } = require('./harness.js');
const PORT = 8129, BASE = `http://localhost:${PORT}/`, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorrun-srv-')), ADMIN = 'test-admin-token';
let fail = 0; const ok = (c, msg) => { if (!c){ fail++; console.log('  NG', msg); } return c; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (u, ip, headers) => fetch(BASE + u, { headers: { 'X-Forwarded-For': ip || '10.0.0.1', ...headers } });
const post = (u, body, ip, headers) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || '10.0.0.1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const filesIn = d => { try { return fs.readdirSync(path.join(DATA, d)); } catch (e) { return []; } };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, TRUST_PROXY: '1', ADMIN_TOKEN: ADMIN, SERVE_ALL: '', VERIFY: '', LIMITS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stderr.on('data', d => { log += d; });
  await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('server:')) res(); }));
  const g = load(['COURSES', 'buildDaily', 'today', 'encodeGhost', 'boardKey', 'solveRoom'], { wall: Date.now() }).m;
  const today = g.today(), daily = g.buildDaily(today), yesterday = g.buildDaily(new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10));
  const normal = g.COURSES[0], nb = botPath(g, normal.rooms, normal.start), nt = Math.round(nb.time * 1000), nKey = g.boardKey(normal), nGhost = g.encodeGhost(nb.bot, nt);
  const rec = (pid, extra) => ({ pid, token: 'token-' + pid, name: 'テスト', t: nt, d: 0, g: nGhost, ...extra });

  console.log('1) 配信');
  let r = await get('');
  const html = await r.text(), csp = r.headers.get('content-security-policy') || '';
  ok(r.status === 200 && /<title>Cursor Run/.test(html), 'ゲーム本体が出ない');
  ok(/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) && /object-src 'none'/.test(csp), 'CSP がない／緩い: ' + csp);
  ok(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff がない');
  r = await fetch(BASE, { headers: { 'Accept-Encoding': 'gzip' } }); ok(r.headers.get('content-encoding') === 'gzip' && (await r.text()).length === html.length, '圧縮して出していない');
  const hidden = ['server.js', 'verify.js', 'harness.js', 'DESIGN.md', 'README.md', 'package.json', 'sound.test.js', 'scripts/shots.js', 'sandbox/objects.html', 'data/boards/x.json', 'node_modules/ws/package.json', '.git/config', '.gitignore', '..%2fserver.js', '%2e%2e/%2e%2e/etc/passwd', 'index.html/../server.js'];
  const leaked = []; for (const f of hidden){ const q = await get(f); if (q.status !== 404) leaked.push(f + ' → ' + q.status); await q.arrayBuffer(); }
  ok(leaked.length === 0, '出してはいけないファイルが出た: ' + leaked.join(', '));
  r = await fetch(BASE, { method: 'DELETE' }); ok(r.status === 405, '想定外のメソッドを断らない');
  ok((await (await get('api/ping')).json()).cursorrun === 1, 'ping');

  console.log('2) 記録');
  const zero = Buffer.alloc(4 + 300 * 3); zero[0] = 1; zero[1] = 30; zero[2] = 300 & 255; zero[3] = 300 >> 8;
  r = await post('api/board/' + nKey, rec('p-fake01', { t: 10000, g: zero.toString('base64') })); let j = await r.json();
  ok(r.status === 400 && !j.ok && /確かめられません/.test(j.err), '偽の記録（中身のないゴースト）が載った: ' + JSON.stringify(j).slice(0, 100));
  r = await post('api/board/' + nKey, rec('p-fake02', { t: 900, g: g.encodeGhost([0, 0, 90, 360, 1, 450, 0, 640, 360, 1, 900, 3, 90, 360, 1], 900) })); j = await r.json();
  ok(!j.ok, '0.9 秒の作り物の記録が載った');
  r = await post('api/board/' + nKey, '{"pid":'); ok(r.status === 400, '壊れた JSON'); r = await post('api/board/' + nKey, 'null'); ok(r.status === 400, 'null'); r = await post('api/board/' + nKey, '[1,2]'); ok(r.status === 400, '配列');
  r = await post('api/board/' + nKey, JSON.stringify({ pad: 'x'.repeat(300000) })).catch(() => ({ status: 413 })); ok(r.status === 413, '大きすぎる本文を断らない: ' + r.status);
  r = await post('api/board/x-random-key-123', rec('p-real01')); j = await r.json(); ok(!j.ok && /読み込み直して/.test(j.err), '知らないコースに載った');
  r = await post('api/board/' + yesterday.key, rec('p-real01', { t: Math.round(yesterday.par * 1000), g: g.encodeGhost(yesterday.bot, yesterday.par * 1000) })); j = await r.json();
  ok(!j.ok && /受付/.test(j.err), '昨日のデイリーに載った'); // 日付が替わって 15 分以内は猶予で通るので、その間はこの1件が NG になる
  ok((await (await get('api/board/' + nKey)).json()).rows.length === 0, '断った記録が表に出ている');
  r = await post('api/board/' + nKey, rec('p-real01')); j = await r.json();
  ok(r.status === 200 && j.ok && j.rows.length === 1, '本物の記録が載らない: ' + j.err);
  ok(j.rows && Object.keys(j.rows[0]).sort().join() === 'd,name,pid,t,ts', '外に出す行に余計な項目がある: ' + Object.keys(j.rows ? j.rows[0] : {}));
  r = await post('api/board/' + daily.key, rec('p-real01', { t: Math.round(daily.par * 1000), g: g.encodeGhost(daily.bot, daily.par * 1000) })); ok((await r.json()).ok, '当日のデイリーに載らない');
  r = await post('api/board/' + nKey, rec('p-real01', { token: 'someone-else-token', t: nt - 1 })); ok(!(await r.json()).ok, '他人の記録を上書きできた');
  for (let i = 0; i < 40; i++){ const q = await get('api/board/d-2026-11-2' + (i % 10) + '-g3-' + String(i).padStart(8, '0'), '10.0.1.' + i); await q.arrayBuffer(); }
  ok(filesIn('boards').length === 2 && filesIn('ghosts').length === 2, `でたらめな識別子でファイルが増えた: boards ${filesIn('boards')} / ghosts ${filesIn('ghosts')}`);
  r = await get('api/ghost/' + nKey + '/p-real01'); ok((await r.json()).g === nGhost, 'ゴーストを取れない');
  r = await get('api/ghost/' + nKey + '/..%2f..%2fboards%2f' + nKey); ok(r.status === 404, 'ゴーストの口から他のファイルを読めた');

  console.log('3) 回数の上限');
  let limited = 0, passed = 0;
  for (let i = 0; i < 60; i++){ const q = await post('api/board/' + nKey, rec('p-spam' + String(i).padStart(2, '0')), '10.9.9.9'); if (q.status === 429) limited++; else if (q.status === 200) passed++; await q.arrayBuffer(); }
  ok(limited >= 15 && passed > 0 && passed <= 40, `送りすぎを止めない: 通った ${passed} / 止めた ${limited}`);
  r = await post('api/board/' + nKey, rec('p-other1'), '10.9.9.10'); ok(r.status === 200, '別の相手まで止めた');
  r = await post('api/board/' + nKey, rec('p-direct'), ''); await r.arrayBuffer(); // X-Forwarded-For なし = つないできた相手そのもの
  ok(r.status === 200, 'X-Forwarded-For なしの相手を扱えない');
  console.log(`   同じ相手から 60 回: 通った ${passed} / 止めた ${limited}`);

  console.log('4) 管理用 API');
  r = await get('api/admin/boards'); ok(r.status === 401, '合言葉なしで管理用 API に入れた');
  r = await get('api/admin/boards', '10.0.0.2', { Authorization: 'Bearer wrong' }); ok(r.status === 401, '違う合言葉で入れた');
  const auth = { Authorization: 'Bearer ' + ADMIN };
  r = await get('api/admin/boards', '10.0.0.2', auth); j = await r.json(); ok(r.status === 200 && j.boards.some(b => b.key === nKey && b.rows >= 2), '表の一覧: ' + JSON.stringify(j).slice(0, 120));
  r = await get('api/admin/board/' + nKey, '10.0.0.2', auth); j = await r.json(); ok(j.rows.length >= 2 && j.rows.every(x => typeof x.sus === 'number' && !('th' in x)), '管理用の行に sus がない／合言葉が出ている');
  const before = j.rows.length;
  r = await post('api/admin/remove', { key: nKey, pid: 'p-other1' }, '10.0.0.2', auth); ok((await r.json()).ok, '行を消せない');
  r = await post('api/admin/remove', { key: nKey, pid: 'p-other1' }, '10.0.0.2', auth); ok(r.status === 404, '無い行を消せたことになった');
  j = await (await get('api/board/' + nKey)).json(); ok(j.rows.length === before - 1 && !j.rows.some(x => x.pid === 'p-other1'), '消した行が残っている');
  ok(!fs.existsSync(path.join(DATA, 'ghosts', nKey, 'p-other1.txt')), '消した行のゴーストが残っている');

  console.log('5) WebSocket');
  const open = (ip) => new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`, { headers: { 'X-Forwarded-For': ip || '10.2.0.1' } }); ws.msgs = []; ws.on('message', d => ws.msgs.push(JSON.parse(d))); ws.on('open', () => res(ws)); ws.on('error', rej); });
  const closed = ws => new Promise(res => { if (ws.readyState === 3) return res(true); ws.on('close', () => res(true)); setTimeout(() => res(ws.readyState === 3), 1500); });
  let ws = await open();
  for (const bad of ['null', '[]', '5', '"x"', '{"t":5}', '{"t":"join","room":{"a":1},"name":["x"]}', 'not json', '{"t":"pick","i":"__proto__"}']) ws.send(bad);
  await sleep(200); ok(ws.readyState === 1 && ws.msgs.some(m => m.t === 'hello'), 'おかしなメッセージの後に入れない');
  for (const bad of ['{"t":"pick","i":"__proto__"}', '{"t":"pick","i":1e99}', '{"t":"place","x":"NaN","y":{}}', '{"t":"pos","x":1e999,"y":null}', '{"t":"dead","by":{"a":1}}', '{"t":"finish"}', '{"t":"ready"}']) ws.send(bad);
  await sleep(300); ok((await (await get('api/ping')).json()).cursorrun === 1, 'おかしなメッセージでサーバーが落ちた');
  const name = ws.msgs.filter(m => m.t === 'state').pop().players[0].name; ok(typeof name === 'string' && name.length <= 12, '名前が文字列でない: ' + JSON.stringify(name));
  ws.send('x'.repeat(5000)); ok(await closed(ws), '大きすぎるメッセージを送った接続が切れない');
  ws = await open('10.2.0.2'); ws.send(JSON.stringify({ t: 'join', room: 'flood', name: 'f' })); await sleep(100);
  for (let i = 0; i < 400; i++) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pos', x: i, y: i }));
  ok(await closed(ws), '連打した接続が切れない');
  const many = []; let refused = 0;
  for (let i = 0; i < 12; i++){ const w = await open('10.2.0.3'); many.push(w); } await sleep(300);
  for (const w of many) if (w.readyState !== 1 || w.msgs.some(m => m.t === 'full')) refused++;
  ok(refused >= 3 && refused <= 5, `同じ相手からの接続数を止めない: 12 本中 ${refused} 本を断った`);
  for (const w of many) w.close();
  const other = await open('10.2.0.4'); other.send(JSON.stringify({ t: 'join', room: 'ok', name: 'だれか' })); await sleep(200);
  ok(other.msgs.some(m => m.t === 'hello') && other.msgs.some(m => m.t === 'state' && m.players[0].name === 'だれか'), '別の相手が入れない'); other.close();
  ok((await (await get('api/ping')).json()).cursorrun === 1, '最後までサーバーが生きている');
  ok(!/\[uncaught\]/.test(log), '想定外の例外が出た: ' + log.slice(0, 300));

  srv.kill();
  console.log(fail ? `SERVER FAIL ${fail}` : 'SERVER OK');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
