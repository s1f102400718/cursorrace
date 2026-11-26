// 外に公開したときの守りのテスト（node server.test.js）。本物のサーバーを立てて、外から来る相手のつもりでたたく
//  1) 配信: ゲーム本体だけ出す（設計書・テスト・サーバーのソース・記録の保存先は 404）。CSP と圧縮
//  2) 記録: 偽の記録・知らないコース・昨日のデイリーは断る／本物は載る／外に出す行に内部の項目（合言葉・sus）が混ざらない／でたらめな識別子でファイルを作らせない
//  3) 回数の上限: 送りすぎた相手だけ 429。別の相手は通る（相手は X-Forwarded-For で見分ける）
//  4) 管理用 API: 合言葉なしは 401。一覧に sus が出る。行を消せる
//  5) WebSocket: おかしなメッセージ・大きすぎるメッセージ・連打でサーバーが落ちない。接続数の上限（受ける前に断る）
//  6) 独立レビューの指摘: 他人の pid を名乗れない／接続元のヘッダーを偽っても上限をすり抜けられない／IPv6 は /64 でまとめる／
//     確かめられない記録を続けると止まる／確認待ちの記録は表に出ず、管理者が通すと出る／名前の見えない文字／壊れた表のファイルを上書きしない／CSP
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const WebSocket = require('ws');
const { load, botPath } = require('./harness.js');
const { verifyRun } = require('./verify.js');
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
  ok(new RegExp("connect-src 'self' ws://localhost:" + PORT + " wss://localhost:" + PORT + ";").test(csp) && !/connect-src[^;]* wss?:(;| )/.test(csp) && /frame-ancestors 'self'/.test(csp), 'CSP: 通信先が自分のホストに限られていない／埋め込みを止めていない: ' + csp);
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
  for (let i = 0; i < 12; i++){ try { many.push(await open('10.2.0.3')); } catch (e) { refused++; } } await sleep(300);
  ok(refused === 4 && many.every(w => w.readyState === 1), `同じ相手からの接続数を止めない: 12 本中 ${refused} 本を断った`);
  // 断られた 9 本目が大きすぎるメッセージを送ろうとしても（そもそもつながらない）、サーバーに拾われない例外が出ない
  for (const w of many) w.close(); await sleep(300);
  const again = await open('10.2.0.3').catch(() => null); ok(!!again, '接続を閉じたあと、同じ相手がまた入れない'); if (again) again.close();
  const other = await open('10.2.0.4'); other.send(JSON.stringify({ t: 'join', room: 'ok', name: 'だれか' })); await sleep(200);
  ok(other.msgs.some(m => m.t === 'hello') && other.msgs.some(m => m.t === 'state' && m.players[0].name === 'だれか'), '別の相手が入れない'); other.close();
  ok((await (await get('api/ping')).json()).cursorrun === 1, '最後までサーバーが生きている');

  console.log('6) 独立レビューの指摘');
  // 他人の pid を名乗って、その人がまだ載っていない表に先に入ることはできない
  const dGhost = g.encodeGhost(daily.bot, daily.par * 1000), dt = Math.round(daily.par * 1000);
  r = await post('api/board/' + nKey, rec('p-victim1'), '10.6.0.1'); ok((await r.json()).ok, '（準備）本人が固定コースに載る');
  r = await post('api/board/' + daily.key, { pid: 'p-victim1', token: 'attacker-token-xyz', name: 'にせもの', t: dt, d: 0, g: dGhost }, '10.6.0.2'); j = await r.json();
  ok(!j.ok && /別の端末/.test(j.err), '他人の pid を名乗ってデイリーに先に入れた');
  r = await post('api/board/' + daily.key, { pid: 'p-victim1', token: 'token-p-victim1', name: 'ほんにん', t: dt, d: 0, g: dGhost }, '10.6.0.1'); ok((await r.json()).ok, '本人はデイリーに載れる');
  ok(/^p-victim1 [0-9a-f]{24}$/m.test(fs.readFileSync(path.join(DATA, 'pids.log'), 'utf8')), 'pid と端末の結びつきが保存されていない');
  // 接続元: TRUST_PROXY=1 では X-Forwarded-For のいちばん後ろだけを信じる。CF-Connecting-IP や、手前に足した偽の値では相手は替わらない
  let lim2 = 0; for (let i = 0; i < 46; i++){ const q = await post('api/board/' + nKey, rec('p-real01'), 'spoof-' + i + ', 10.6.1.1', { 'CF-Connecting-IP': '10.77.' + i + '.1' }); if (q.status === 429) lim2++; await q.arrayBuffer(); }
  ok(lim2 === 6, `接続元のヘッダーを偽ると上限をすり抜ける: 46 回中 ${lim2} 回しか止めない`);
  // IPv6 は /64 でまとめる（アドレスの下半分を替えても同じ相手）。別の /64 は別の相手
  let lim3 = 0; for (let i = 0; i < 46; i++){ const q = await post('api/board/' + nKey, rec('p-real01'), '2001:db8:1:2:' + i.toString(16) + '::' + (i + 1).toString(16)); if (q.status === 429) lim3++; await q.arrayBuffer(); }
  ok(lim3 === 6, `IPv6 のアドレスを替えると上限をすり抜ける: 46 回中 ${lim3} 回しか止めない`);
  r = await post('api/board/' + nKey, rec('p-real01'), '2001:db8:1:3::1'); ok(r.status === 200, '別の /64 まで止めた'); await r.arrayBuffer();
  // 確かめられない記録を続けて送ると止まる（検証の計算を攻撃の道具にさせない）。止まるのはその相手だけ
  const codes = []; for (let i = 0; i < 9; i++){ const q = await post('api/board/' + nKey, rec('p-bad' + String(i).padStart(3, '0'), { t: 10000, g: zero.toString('base64') }), '10.6.2.1'); codes.push(q.status); await q.arrayBuffer(); }
  ok(codes.slice(0, 6).every(c => c === 400) && codes.slice(6).every(c => c === 429), '確かめられない記録を続けても止まらない: ' + codes.join(' '));
  r = await post('api/board/' + nKey, rec('p-good01'), '10.6.2.2'); ok(r.status === 200, '別の相手の本物の記録まで止めた'); await r.arrayBuffer();
  // 失敗した送信は「新しい人」として数えない（学校などの共有回線で、誰かの失敗が他の人の登録枠を減らさない）
  for (let i = 0; i < 5; i++){ const q = await post('api/board/' + nKey, rec('p-fail' + i + 'xx', { t: 10000, g: zero.toString('base64') }), '10.6.3.1'); await q.arrayBuffer(); }
  let fresh = 0; for (let i = 0; i < 30; i++){ const q = await post('api/board/' + nKey, rec('p-fresh' + String(i).padStart(2, '0')), '10.6.3.1'); if (q.status === 200) fresh++; await q.arrayBuffer(); }
  ok(fresh === 30, `失敗した送信が新規登録の枠を減らした: 30 人中 ${fresh} 人しか載らない`);
  // 確認待ち: 障害物へのめり込みが多い走り（BOT の道を時刻だけ速めたもの）は、載るが表に出ない。管理者が通すと出る
  let held = null;
  for (const c of [...g.COURSES, daily]){ const b = c.bot ? { bot: c.bot, time: c.par } : botPath(g, c.rooms, c.start);
    for (const k of [2, 2.5, 3, 4, 5]){ const tt = Math.round(b.time * 1000 / k), gg = g.encodeGhost(b.bot.map((v, i) => i % 5 === 0 ? Math.round(v / k) : v), tt), v = verifyRun(c, gg, tt, 0); if (v.ok && v.hold){ held = { key: c.key || g.boardKey(c), t: tt, g: gg, sus: v.sus }; break; } }
    if (held) break; }
  if (ok(!!held, '確認待ちになる走りを作れなかった（しきい値の確認ができない）')){
    r = await post('api/board/' + held.key, rec('p-held01', { t: held.t, g: held.g }), '10.6.4.1'); j = await r.json();
    ok(j.ok && j.held === true && !j.rows.some(x => x.pid === 'p-held01'), '確認待ちの記録が表に出た／確認待ちと伝えていない: ' + JSON.stringify({ ok: j.ok, held: j.held, err: j.err }));
    r = await get('api/admin/board/' + held.key, '10.0.0.2', auth); j = await r.json(); const hr = j.rows.find(x => x.pid === 'p-held01');
    ok(hr && hr.hold === true && hr.sus >= 3, '管理用の一覧に確認待ちが出ない: ' + JSON.stringify(hr));
    r = await post('api/admin/approve', { key: held.key, pid: 'p-held01' }, '10.0.0.2', auth); ok((await r.json()).ok, '確認待ちを通せない');
    j = await (await get('api/board/' + held.key)).json(); ok(j.rows.some(x => x.pid === 'p-held01'), '通した記録が表に出ない');
    console.log(`   確認待ちにした走り: ${held.key} ${held.t}ms（めり込み ${held.sus}）`);
  }
  // 名前: 見えない文字・向きを変える文字・制御文字を落とす。BOT は名乗れない
  r = await post('api/board/' + nKey, rec('p-name01', { name: '\u202Eabc\u200B\u009Bd\u0000ｅ' }), '10.6.5.1'); j = await r.json();
  ok(j.ok && j.rows.find(x => x.pid === 'p-name01').name === 'abcde', '名前の見えない文字が残った: ' + JSON.stringify(j.rows && j.rows.find(x => x.pid === 'p-name01')));
  r = await post('api/board/' + nKey, rec('p-name02', { name: 'ＢＯＴ' }), '10.6.5.1'); j = await r.json(); ok(!j.ok && /名前/.test(j.err), 'BOT を名乗れた');
  r = await post('api/board/' + nKey, rec('p-name03', { name: '\u200B\u200B' }), '10.6.5.1'); ok(!(await r.json()).ok, '見えない文字だけの名前が通った');
  // 管理用 API: 間違った合言葉を続けると、しばらく全体を止める（総当たりへの備え）
  let a401 = 0, a429 = 0; for (let i = 0; i < 14; i++){ const q = await get('api/admin/boards', '10.6.6.' + i, { Authorization: 'Bearer wrong-' + i }); if (q.status === 401) a401++; else if (q.status === 429) a429++; await q.arrayBuffer(); }
  ok(a401 <= 10 && a429 >= 4, `管理用 API の合言葉を試し続けられる: 401 ${a401} / 429 ${a429}`);

  ok(!/\[uncaught\]/.test(log), '想定外の例外が出た: ' + log.slice(0, 300));
  srv.kill(); await sleep(300);
  // 壊れた表のファイルがあっても、空の表として扱って上書きしない（読めないときは 500 を返して、ファイルはそのまま）
  const bf = path.join(DATA, 'boards', nKey + '.json'), good = fs.readFileSync(bf, 'utf8'); fs.writeFileSync(bf, good.slice(0, good.length - 20));
  const srv2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, TRUST_PROXY: '1', ADMIN_TOKEN: 'short', SERVE_ALL: '', VERIFY: '', LIMITS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out2 = ''; srv2.stderr.on('data', () => {}); await new Promise(res => srv2.stdout.on('data', d => { out2 += d; if (String(d).includes('server:')) res(); }));
  r = await post('api/board/' + nKey, rec('p-after01'), '10.6.7.1'); ok(r.status === 500, '壊れた表に書き込んだ: ' + r.status); await r.arrayBuffer();
  ok(fs.readFileSync(bf, 'utf8') === good.slice(0, good.length - 20), '壊れた表のファイルを上書きした');
  fs.writeFileSync(bf, good); r = await post('api/board/' + nKey, rec('p-after01'), '10.6.7.1'); j = await r.json(); ok(j.ok && j.rows.length > 5, '直した表に載らない');
  r = await post('api/board/' + daily.key, { pid: 'p-victim1', token: 'attacker-token-xyz', name: 'にせもの', t: dt, d: 0, g: dGhost }, '10.6.7.2'); ok(!(await r.json()).ok, '再起動したら pid の結びつきを忘れた');
  ok(/ADMIN_TOKEN が短すぎます/.test(out2) && (await get('api/admin/boards', '10.6.7.3', { Authorization: 'Bearer short' })).status === 404, '短い合言葉で管理用 API が有効になった');
  srv2.kill(); await sleep(300);
  // 開発用の全配信（SERVE_ALL=1）でも、記録の保存先・node_modules・ドットで始まるものは、書き方を変えても出さない
  const srv3 = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: path.join(__dirname, 'data-test-' + process.pid), SERVE_ALL: '1', FAST: '1', MAX_ROUNDS: '3', VERIFY: '', LIMITS: '', TRUST_PROXY: '', ADMIN_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv3.stderr.on('data', () => {}); await new Promise(res => srv3.stdout.on('data', d => { if (String(d).includes('server:')) res(); }));
  try {
    fs.mkdirSync(path.join(__dirname, 'data-test-' + process.pid, 'boards'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'data-test-' + process.pid, 'boards', 'secret.json'), '[]');
    ok((await fetch(BASE + 'DESIGN.md')).status === 200, 'SERVE_ALL=1 で設計書が出ない（開発用の全配信が効いていない）');
    const raw = p => new Promise(res => { const q = require('http').request({ host: 'localhost', port: PORT, path: p }, r => { r.resume(); res(r.statusCode); }); q.on('error', () => res(0)); q.end(); }); // fetch は道を整えてしまうので、書いたとおりに送る
    const sneaky = ['/node_modules/ws/package.json', '//node_modules/ws/package.json', '/NODE_MODULES/ws/package.json', '/node_modules%5Cws%5Cpackage.json', '/server.js::$DATA', '/.git/config', '/.gitignore', '/data-test-' + process.pid + '/boards/secret.json', '/DATA-TEST-' + process.pid + '/boards/secret.json', '/sandbox/../data-test-' + process.pid + '/boards/secret.json', '/scripts/../.git/config'];
    const got = []; for (const p of sneaky){ const c = await raw(p); if (c !== 404) got.push(p + ' → ' + c); }
    ok(got.length === 0, 'SERVE_ALL=1 で出してはいけないものが出た: ' + got.join(', '));
    // 対戦: 誰も点を取らないまま続いても、決めたラウンド数で終わる（置かれたピースが際限なく増えない）
    const solo = new WebSocket(`ws://localhost:${PORT}`), phases = []; let lastState = null;
    solo.on('message', d => { const m = JSON.parse(d); if (m.t === 'state'){ lastState = m; if (phases[phases.length - 1] !== m.phase) phases.push(m.phase); if (m.phase === 'box' && m.players[0].pick === null) solo.send(JSON.stringify({ t: 'pick', i: 0 })); if (m.phase === 'place' && !m.players[0].placed) solo.send(JSON.stringify({ t: 'place', x: 640, y: 150 + m.round * 40 })); } });
    await new Promise(res => solo.on('open', res)); solo.send(JSON.stringify({ t: 'join', room: 'endless', name: 'ひとり' })); await sleep(100); solo.send(JSON.stringify({ t: 'ready' }));
    for (let i = 0; i < 120 && !phases.includes('final'); i++) await sleep(100);
    ok(phases.includes('final') && lastState && lastState.round === 3 && lastState.winner && lastState.winner.name === 'ひとり', `点が入らない対戦が 3 ラウンドで終わらない: ラウンド ${lastState && lastState.round} / ${phases.slice(-4).join(' → ')}`);
    solo.close();
  } finally { srv3.kill(); await sleep(300); try { fs.rmSync(path.join(__dirname, 'data-test-' + process.pid), { recursive: true, force: true }); } catch (e) {} }
  console.log(fail ? `SERVER FAIL ${fail}` : 'SERVER OK');
  process.exit(fail ? 1 : 0);
  // eslint-disable-next-line no-unreachable
  ok(true, '');

  srv.kill();
  console.log(fail ? `SERVER FAIL ${fail}` : 'SERVER OK');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
