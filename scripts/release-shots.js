// 公開前の確認を実ブラウザで（node scripts/release-shots.js）。test-out/r-*.png と、共有用の画像 og.png を作る
//   本番と同じ配信（配信ファイルの限定・CSP・回数の上限つき）のサーバーにつないで確かめる:
//   1) 初めて開くと「あそびかた」が出る → 閉じると覚える → H でまた見られる。CSP 違反やエラーが出ない
//   2) タッチだけの端末では注意書きが出る
//   3) ONLINE: 部屋が自動で作られて URL に入る。その URL を開いた2人目が同じ部屋に入る
//   4) 記録の送信がサーバーの検証を通る（BOT の走りで完走 → ランキングに載る）
//   5) 共有用の画像 og.png（1200×630）を作る
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const { chromium, devices } = require('playwright-core');
const root = path.join(__dirname, '..'), out = path.join(root, 'test-out'), PORT = 8130, BASE = `http://localhost:${PORT}/`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorrun-rel-'));
fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, SERVE_ALL: '', VERIFY: '', LIMITS: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('server:')) res(); }));
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const errors = [];
  const watch = (page, tag) => { page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource/.test(m.text()) && !(tag === 'static' && /WebSocket connection/.test(m.text()))) errors.push(tag + ': ' + m.text()); }); // 置くだけの版で ONLINE を押したときの接続失敗は、確かめたい状況そのもの
  ; page.on('pageerror', e => errors.push(tag + ': ' + e)); };
  const check = (c, msg) => { console.log((c ? 'ok  ' : 'NG  ') + msg); if (!c) errors.push(msg); };
  const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });

  // ---- 1) 初めて開く ----
  const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 720 } }), page = await ctx1.newPage(); watch(page, 'pc');
  const resp = await page.goto(BASE);
  check(/sha256-/.test(resp.headers()['content-security-policy'] || ''), '本番の配信（CSP つき）で開いた');
  await until(page, () => { const c = DAILIES.get(today()); return c && !c.building; }); await sleep(500);
  check(await page.evaluate(() => OV.mode === 'help' && !document.getElementById('overlay').hidden && document.querySelectorAll('#ovHelp li').length === 5 && !document.querySelector('#ovHelp .warn')), '初めて開くと「あそびかた」が出る（PC では注意書きなし）');
  await page.screenshot({ path: path.join(out, 'r-01-first-visit.png') });
  await page.keyboard.press('1'); check(await page.evaluate(() => state === 'menu'), '「あそびかた」が出ている間はゲームのキーが効かない');
  await page.keyboard.press('Enter'); await sleep(150);
  check(await page.evaluate(() => OV.mode === null && document.getElementById('overlay').hidden && localStorage.getItem('cursorrun.seen') === '1' && state === 'menu'), 'Enter で閉じて、見たことを覚える');
  await page.mouse.move(415, 602); await sleep(250); await page.screenshot({ path: path.join(out, 'r-02-menu.png') });
  await page.mouse.click(415, 602); await sleep(150); check(await page.evaluate(() => OV.mode === 'help'), 'メニューの「あそびかた」で開く');
  await page.keyboard.press('Escape'); await page.keyboard.press('h'); await sleep(100); check(await page.evaluate(() => OV.mode === 'help'), 'H キーでも開く'); await page.keyboard.press('Escape');
  await page.reload(); await until(page, () => { const c = DAILIES.get(today()); return c && !c.building; }); await sleep(300);
  check(await page.evaluate(() => OV.mode === null), '2回目からは出ない');
  const meta = await page.evaluate(() => ({ desc: document.querySelector('meta[name=description]').content.length, og: document.querySelector('meta[property="og:image"]').content, icon: document.querySelector('link[rel=icon]').href.slice(0, 19), fontOk: document.fonts.check('700 20px "Chakra Petch"') }));
  check(meta.desc > 30 && meta.og === 'og.png' && meta.icon === 'data:image/svg+xml,', '説明文・共有用の画像・アイコンの指定がある');

  // ---- 4) 記録の送信がサーバーの検証を通る ----
  await until(page, () => NET.mode === 'api');
  await page.keyboard.press('1'); await until(page, () => state === 'board'); await page.keyboard.press('Enter'); await until(page, () => state === 'title');
  const run = await page.evaluate(async () => {
    const raf = window.__raf || (window.__raf = window.requestAnimationFrame); window.requestAnimationFrame = () => 0; await new Promise(r => raf(() => raf(r)));
    const bot = []; let tt = 0, pos = course.start;
    for (let i = 0; i < ROOMS.length; i++){ const s = solveRoom(ROOMS[i], pos, ROOMS[i].exit, tt, true, 40); if (!s.ok) return { fail: i }; for (const p of s.path) bot.push(Math.round(p.t * 1000), i, p.x, p.y, 1); tt += s.time; pos = s.path[s.path.length - 1]; }
    let t = performance.now() - 60000; samples.push({ x: bot[2], y: bot[3] }); update(t += 16);
    for (let i = 0; i < 400 && state === 'count'; i++) update(t += 16);
    const t0 = t; let last = -1;
    for (let i = 0; i < bot.length && state === 'race'; i += 5){ if (bot[i] === last) continue; last = bot[i]; t = t0 + bot[i]; samples.push({ x: bot[i + 2], y: bot[i + 3] }); update(t); }
    window.requestAnimationFrame = raf; raf(loop);
    return { state, deaths, finalTime };
  });
  check(run.state === 'done' && run.deaths === 0, 'BOT の走りで完走: ' + JSON.stringify(run));
  await until(page, () => /rank/.test(document.getElementById('msg').textContent)).catch(() => {});
  const rank = await page.evaluate(() => ({ msg: document.getElementById('msg').textContent, sent: (loadRec(boardKey(course)) || {}).sent, toast: document.getElementById('toast').textContent }));
  check(/rank#1 \/ 1人/.test(rank.msg.replace(/\s/g, '').replace('rank', 'rank')) || /api\|/.test(rank.sent || ''), 'サーバーが走りを確かめて、ランキングに載った（' + (rank.sent || rank.toast) + '）');
  const rows = await (await fetch(BASE + 'api/board/c-normal-v0_2')).json(); check(rows.rows.length === 1 && Math.abs(rows.rows[0].t - Math.round(run.finalTime * 1000)) <= 1, 'サーバーの表に 1 行: ' + JSON.stringify(rows.rows).slice(0, 100));
  await page.screenshot({ path: path.join(out, 'r-03-ranked.png') });

  // ---- 2) タッチだけの端末 ----
  const ctx2 = await browser.newContext({ ...devices['iPhone 13 landscape'] }), phone = await ctx2.newPage(); watch(phone, 'phone');
  await phone.goto(BASE); await until(phone, () => typeof OV !== 'undefined' && OV.mode === 'help'); await sleep(400);
  check(await phone.evaluate(() => TOUCH_ONLY && !!document.querySelector('#ovHelp .warn')), 'タッチだけの端末では注意書きが出る');
  const fit = await phone.evaluate(() => { const b = document.querySelector('#overlay .box').getBoundingClientRect(); return { h: Math.round(b.height), vh: innerHeight, top: Math.round(b.top), bottom: Math.round(b.bottom), sw: document.documentElement.scrollWidth, vw: innerWidth }; });
  check(fit.top >= 0 && fit.bottom <= fit.vh && fit.sw <= fit.vw, 'スマホの横画面で「あそびかた」が画面に収まる: ' + JSON.stringify(fit));
  await phone.screenshot({ path: path.join(out, 'r-04-phone-help.png') });
  await ctx2.close();
  const ctx2b = await browser.newContext({ ...devices['iPhone 13'] }), tall = await ctx2b.newPage(); watch(tall, 'phone-tall');
  await tall.goto(BASE); await until(tall, () => typeof OV !== 'undefined' && OV.mode === 'help'); await sleep(400);
  const fit2 = await tall.evaluate(() => { const b = document.querySelector('#overlay .box').getBoundingClientRect(), ok = document.getElementById('ovOk').getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: innerHeight, okBottom: Math.round(ok.bottom), sw: document.documentElement.scrollWidth, vw: innerWidth }; });
  check(fit2.okBottom <= fit2.vh && fit2.top >= 0 && fit2.sw <= fit2.vw, 'スマホの縦画面でも「はじめる」まで届く: ' + JSON.stringify(fit2));
  await tall.screenshot({ path: path.join(out, 'r-05-phone-tall-help.png') });
  await ctx2b.close();

  // ---- 3) ONLINE: 部屋が作られて URL に入り、その URL で2人目が合流する ----
  await page.keyboard.press('m'); await until(page, () => state === 'menu');
  await page.keyboard.press('4'); await until(page, () => state === 'mp' && MP.snap && MP.snap.phase === 'lobby');
  const url = page.url(), code = await page.evaluate(() => MP.snap.code);
  check(/[?&]room=[0-9a-f]{6}/.test(url) && url.includes(code), '部屋が自動で作られて URL に入る: ' + url.replace(BASE, '/'));
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 720 } }), friend = await ctx3.newPage(); watch(friend, 'friend');
  await friend.addInitScript(() => { try { localStorage.setItem('cursorrun.seen', '1'); } catch (e) {} });
  await friend.goto(url); await until(friend, () => typeof DAILIES !== 'undefined' && state === 'menu'); await friend.keyboard.press('4');
  await until(page, () => MP.snap && MP.snap.players.length === 2); await page.mouse.move(640, 500); await sleep(300);
  check(await friend.evaluate(c => MP.snap && MP.snap.code === c && MP.snap.players.length === 2, code), 'その URL を開いた2人目が同じ部屋に入る');
  await page.screenshot({ path: path.join(out, 'r-06-lobby.png') });
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 720 } }), stranger = await ctx4.newPage(); watch(stranger, 'stranger');
  await stranger.addInitScript(() => { try { localStorage.setItem('cursorrun.seen', '1'); } catch (e) {} });
  await stranger.goto(BASE); await until(stranger, () => typeof DAILIES !== 'undefined' && state === 'menu'); await stranger.keyboard.press('4'); await until(stranger, () => MP.snap && MP.snap.phase === 'lobby');
  check(await stranger.evaluate(c => MP.snap.code !== c && MP.snap.players.length === 1, code), 'URL を知らない人は別の部屋になる');
  await ctx3.close(); await ctx4.close();

  // ---- 5) 共有用の画像（1200×630）。EXTREME の走行中の場面に題名を重ねる ----
  const ctx5 = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 }), og = await ctx5.newPage(); watch(og, 'og');
  await og.addInitScript(() => { try { localStorage.setItem('cursorrun.seen', '1'); } catch (e) {} });
  await og.goto(BASE); await until(og, () => typeof DAILIES !== 'undefined' && state === 'menu');
  await og.evaluate(async () => {
    await document.fonts.ready; SFX.on = false;
    const raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; await new Promise(r => raf(() => raf(r)));
    // EXTREME の2部屋目（全方向の弾幕）。入口のパッドの中は安全なので、そこで弾が広がるのを待ってから少し動いて尻尾を出す
    openBoard(COURSES[2]); play(); let t = performance.now() - 60000;
    samples.push({ x: 90, y: 360 }); update(t += 16); for (let i = 0; i < 400 && state === 'count'; i++) update(t += 16);
    enterRoom(1); const e = roomEntry(1), dir = e.x > 640 ? -1 : 1;
    for (let i = 0; i < 230; i++){ samples.push({ x: e.x, y: e.y }); update(t += 16); }
    for (let i = 1; i <= 9; i++){ samples.push({ x: e.x + dir * i * 4, y: e.y - i * 2 }); update(t += 16); }
    window.__og = { state, room: ROOMS[roomIdx].name, prims: prims(ROOMS[roomIdx], elapsed).length };
    for (const id of ['hud', 'keys', 'msg', 'toast']) document.getElementById(id).style.display = 'none';
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:0 64px 56px;background:linear-gradient(180deg,rgba(7,9,15,0) 35%,rgba(7,9,15,.92) 88%);font-family:"Chakra Petch",sans-serif;color:#e6ecf5;pointer-events:none';
    d.innerHTML = '<div style="font-size:112px;font-weight:700;letter-spacing:.06em;line-height:1">CURSOR RUN</div><div style="font-size:34px;font-weight:500;margin-top:14px;color:#5ee1ff">カーソルが自機のタイムアタック</div>';
    document.body.appendChild(d);
  });
  const scene = await og.evaluate(() => window.__og); check(scene.state === 'race' && scene.prims > 20, '共有用の画像の場面: ' + JSON.stringify(scene));
  await sleep(200); await og.screenshot({ path: path.join(root, 'og.png') });
  const size = fs.statSync(path.join(root, 'og.png')).size; check(size > 20000 && size < 900000, `共有用の画像 og.png を作った（${Math.round(size / 1024)}KB）`);
  const ogResp = await fetch(BASE + 'og.png'); check(ogResp.status === 200 && ogResp.headers.get('content-type') === 'image/png', 'サーバーが og.png を配信する');

  // ---- 6) 置くだけの版（API も WebSocket も無い場所）でも遊べる ----
  const http = require('http');
  const stat = http.createServer((q, r) => { const u = q.url.split('?')[0]; if (u === '/' || u === '/index.html'){ r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(fs.readFileSync(path.join(root, 'index.html'))); } else { r.writeHead(404, { 'Content-Type': 'text/html' }); r.end('<h1>404</h1>'); } });
  await new Promise(res => stat.listen(PORT + 1, res));
  const ctx6 = await browser.newContext({ viewport: { width: 1280, height: 720 } }), sp = await ctx6.newPage(); watch(sp, 'static');
  await sp.addInitScript(() => { try { localStorage.setItem('cursorrun.seen', '1'); } catch (e) {} });
  await sp.goto(`http://localhost:${PORT + 1}/`); await until(sp, () => { const c = DAILIES.get(today()); return c && !c.building; }); await sleep(600);
  check(await sp.evaluate(() => NET.mode === 'local'), '置くだけの版: ランキングは端末の中だけ（local）');
  await sp.keyboard.press('Enter'); await until(sp, () => state === 'board'); await sp.keyboard.press('Enter'); await until(sp, () => state === 'title');
  const srun = await sp.evaluate(async () => {
    const raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; await new Promise(r => raf(() => raf(r)));
    const bot = course.bot; let t = performance.now() - 60000; samples.push({ x: bot[2], y: bot[3] }); update(t += 16);
    for (let i = 0; i < 400 && state === 'count'; i++) update(t += 16);
    const t0 = t; let last = -1;
    for (let i = 0; i < bot.length && state === 'race'; i += 5){ if (bot[i] === last) continue; last = bot[i]; t = t0 + bot[i]; samples.push({ x: bot[i + 2], y: bot[i + 3] }); update(t); }
    window.requestAnimationFrame = raf; raf(loop);
    return { state, deaths, best: !!loadRec(boardKey(course)) };
  });
  check(srun.state === 'done' && srun.best, '置くだけの版: デイリーを完走して自己ベストが残る ' + JSON.stringify(srun));
  await sp.keyboard.press('b'); await until(sp, () => state === 'board'); await sleep(300);
  check(await sp.evaluate(() => boardRows(course).some(r => r.me) && boardRows(course).some(r => r.bot)), '置くだけの版: ランキング画面に自分と BOT が出る');
  await sp.screenshot({ path: path.join(out, 'r-07-static-board.png') });
  await sp.keyboard.press('m'); await until(sp, () => state === 'menu'); await sp.keyboard.press('4'); await sleep(1500);
  check(await sp.evaluate(() => state === 'mp' && !MP.snap && /接続できません/.test(MP.note)), '置くだけの版: ONLINE は「接続できません」と出て、止まらない');
  await sp.keyboard.press('m'); await until(sp, () => state === 'menu');
  await ctx6.close(); stat.close();

  await browser.close(); srv.kill();
  console.log(errors.length ? 'RELEASE SHOTS FAIL\n' + errors.join('\n') : 'RELEASE SHOTS OK');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
