// 実ブラウザでの確認（node scripts/shots.js）。test-out/ に画面を保存し、コンソールエラーがあれば失敗にする。
// 流れ: サーバー起動 → 他プレイヤー7人ぶんの記録を登録 → メニュー → デイリーのランキング → BOTの経路で完走
//      → 結果 → リプレイ → ランキング（順位つき）→ ゴースト並走 → 複数リプレイ → 固定コース → 名前入力
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { load } = require(path.join(__dirname, '..', 'harness.js'));
const root = path.join(__dirname, '..'), out = path.join(root, 'test-out'), PORT = 8126, BASE = `http://localhost:${PORT}/`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorrun-shots-'));
fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('server:')) res(); }));
  // 他プレイヤーの記録。BOTの経路を時間方向に引き伸ばしたもの（見た目の確認用なので障害物とは合っていない）
  const base = load(['buildDaily', 'today', 'encodeGhost'], { wall: Date.now() }), today = base.m.today(), course = base.m.buildDaily(today);
  const others = [['ねこ42', 1.45, 0], ['うま17', 1.62, 1], ['きつね88', 1.9, 0], ['くま03', 2.3, 2], ['かえる55', 2.75, 4], ['さる71', 3.4, 3], ['いぬ29', 4.1, 7]];
  for (const [name, k, d] of others){
    const s = course.bot.map((v, i) => i % 5 === 0 ? Math.round(v * k) : v), t = Math.round(course.par * 1000 * k);
    const r = await (await fetch(BASE + 'api/board/' + course.key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: 'seed-' + Math.round(k * 100), token: 'seed-token-' + name, name, t, d, g: base.m.encodeGhost(s, t) }) })).json();
    if (!r.ok) throw new Error('seed failed: ' + JSON.stringify(r));
  }

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(r.status() + ' ' + r.url()); }); // 読み込み失敗はURLつきで拾う
  page.on('pageerror', e => errors.push(String(e)));
  const st = () => page.evaluate(() => state);
  const shot = async name => { await page.screenshot({ path: path.join(out, name + '.png') }); console.log(name.padEnd(22), await st()); };
  const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });

  await page.goto(BASE + '?name=' + encodeURIComponent('じぶん'));
  await until(() => { const c = DAILIES.get(today()); return c && !c.building && NET.mode === 'api'; });
  await page.mouse.move(420, 400); await sleep(1200);
  await shot('01-menu');

  await page.mouse.click(400, 214); await until(() => state === 'board' && netRows(boardKey(course)) !== null);
  await page.mouse.move(860, 250); await sleep(600);
  await shot('02-board-first');

  // BOTの経路で完走させる。実時間だとフレームの揺れで死ぬことがあるので、この間だけ時刻を手で進める
  await page.keyboard.press('Enter'); await until(() => state === 'title');
  const run = await page.evaluate(() => {
    const raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0;
    const bot = buildDaily(course.daily.date).bot; let t = performance.now() - 30000; // 過去の時刻で回す（実時間に戻したとき時刻が逆行しないように）
    samples.push({ x: bot[2], y: bot[3] }); update(t += 16);
    for (let i = 0; i < 400 && state === 'count'; i++) update(t += 16);
    const t0 = t; let last = -1;
    for (let i = 0; i < bot.length && state === 'race'; i += 5){ if (bot[i] === last) continue; last = bot[i]; t = t0 + bot[i]; samples.push({ x: bot[i + 2], y: bot[i + 3] }); update(t); }
    window.requestAnimationFrame = raf; raf(loop);
    return { state, deaths, finalTime };
  });
  console.log('run', JSON.stringify(run)); if (run.state !== 'done' || run.deaths) errors.push('bot run failed in browser: ' + JSON.stringify(run));
  await until(() => /rank/.test(document.getElementById('msg').textContent)); await sleep(300);
  await shot('03-done');

  await page.keyboard.press('w'); await until(() => state === 'watch'); await sleep(2600);
  await shot('04-replay-last');
  await page.keyboard.press('b'); await until(() => state === 'done');
  await page.keyboard.press('b'); await until(() => state === 'board' && (BOARD.sel.get(boardKey(course)) || []).length > 0);
  // BOT も並走相手に足す（表の最後の行）
  const botRow = await page.evaluate(() => { const rows = boardRows(course); return { y: BL.y + (rows.length - 1 - BOARD.scroll) * BL.rh + BL.rh / 2, n: rows.length }; });
  await page.mouse.click(700, botRow.y); await page.mouse.move(900, 300); await sleep(900);
  await shot('05-board-ranked');

  await page.keyboard.press('Enter'); await until(() => state === 'title');
  await page.mouse.move(120, 380); await page.mouse.move(90, 360); await until(() => state === 'race'); await sleep(450);
  await shot('06-race-ghosts');
  await page.keyboard.press('Escape'); await until(() => state === 'board');
  await page.keyboard.press('w'); await until(() => state === 'watch'); await sleep(3200);
  await page.keyboard.press(' '); await page.mouse.move(640, 300); await sleep(200);
  await shot('07-replay-multi');
  await page.mouse.click(WLX(0.62), 692); await sleep(300); // タイムラインをクリックしてシーク
  await shot('08-replay-seek');
  await page.keyboard.press('b'); await until(() => state === 'board');
  await page.keyboard.press('ArrowLeft'); await sleep(400); // 初日なので「前の日」は無効のはず
  await page.keyboard.press('m'); await until(() => state === 'menu'); await page.mouse.move(700, 620); await sleep(500);
  await shot('09-menu-after');
  await page.keyboard.press('2'); await until(() => state === 'board' && course.id === 'hard' && course.bot && course.bot.length > 0); await page.mouse.move(300, 300); await sleep(500);
  await shot('10-board-hard');
  await page.keyboard.press('n'); await sleep(300);
  await shot('11-name');
  await page.keyboard.press('Escape');
  // 小さい窓でも崩れないか
  await page.setViewportSize({ width: 800, height: 520 }); await page.keyboard.press('m'); await page.keyboard.press('Enter'); await until(() => state === 'board' && !!course.daily); await sleep(500);
  await shot('12-board-small');

  await browser.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(errors.length ? 'SHOTS FAIL\n' + errors.join('\n') : 'SHOTS OK → test-out/');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
function WLX(f){ return 150 + 980 * f; }
