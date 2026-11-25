// カーソルの形を場面ごとに実ブラウザで撮る（node scripts/cursor-shots.js）。test-out/c-*.png
// 全体の画面と、カーソルの周りを4倍に拡大した切り抜きを保存する。場面ごとに cursorKind() が期待どおりかも確かめる。
//   一人: メニュー（何もない所／カードの上）→ ランキング → スタート前 → パッドに乗る → 走行中 → リプレイ
//   マルチ: ロビー → 箱 → 設置 → スタート待ち → 走行中（相手は node 側の偽クライアント）
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const root = path.join(__dirname, '..'), out = path.join(root, 'test-out'), PORT = 8127, BASE = `http://localhost:${PORT}/`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorrun-cur-'));
fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('server:')) res(); }));
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });
  let pos = { x: 0, y: 0 };
  const move = async (x, y) => { pos = { x, y }; await page.mouse.move(x - 30, y - 20); await page.mouse.move(x, y); };
  // 場面を撮る。want = 期待する形（game / ui / place）、hot = 「押せる」形のはずか
  const shot = async (name, want, hot) => {
    await sleep(350); // 形が替わった直後の弾みが収まってから撮る
    const got = await page.evaluate(() => ({ kind: cursorKind(), hot: UIC.hot, state, phase: MP.snap ? MP.snap.phase : '', trail: trail.length }));
    await page.screenshot({ path: path.join(out, `c-${name}.png`) });
    await page.screenshot({ path: path.join(out, `c-${name}-zoom.png`), clip: { x: Math.max(0, pos.x - 60), y: Math.max(0, pos.y - 45), width: 120, height: 90 }, scale: 'device' });
    const ok = got.kind === want && (hot === undefined || got.hot === hot);
    console.log(`${name.padEnd(16)} ${ok ? 'ok ' : 'NG '} ${JSON.stringify(got)}`);
    if (!ok) errors.push(`${name}: want ${want}${hot === undefined ? '' : ' hot=' + hot}, got ${JSON.stringify(got)}`);
  };

  // ---- 一人プレイ ----
  await page.goto(BASE + '?name=' + encodeURIComponent('じぶん'));
  await until(() => { const c = DAILIES.get(today()); return c && !c.building; });
  await move(1000, 600); await shot('01-menu', 'ui', false);
  await move(420, 250); await shot('02-menu-hover', 'ui', true);
  await page.keyboard.press('1'); await until(() => state === 'board');
  await until(() => boardRows(course).length > 0);
  await move(700, 168); await shot('03-board-row', 'ui', true); // 順位表の1行目（記録が無くても BOT の行がある）
  await move(135, 480); await shot('04-board-play', 'ui', true);
  await page.keyboard.press('Enter'); await until(() => state === 'title');
  await move(420, 250); await shot('05-title', 'ui', false);
  await move(90, 360); await until(() => state === 'count'); await sleep(60);
  await page.screenshot({ path: path.join(out, 'c-06-count-pop-zoom.png'), clip: { x: 30, y: 315, width: 120, height: 90 } }); // 自機に替わった直後（輪が広がる）
  await shot('06-count', 'game');
  await until(() => state === 'race'); await move(170, 360); await shot('07-race', 'game');
  const css = await page.evaluate(() => ({ cur: getComputedStyle(document.documentElement).getPropertyValue('--cur').slice(0, 30), hot: getComputedStyle(document.documentElement).getPropertyValue('--cur-hot').slice(0, 30) }));
  console.log('css', JSON.stringify(css)); if (!/^url\("data:image\/svg/.test(css.cur) || !/^url\("data:image\/svg/.test(css.hot)) errors.push('CSS カーソルが入っていない');
  await page.keyboard.press('m'); await until(() => state === 'menu');

  // ---- マルチ ----
  let B = null, bId = null; const f = {};
  const connectB = () => new Promise(res => {
    B = new WebSocket(`ws://localhost:${PORT}`);
    B.on('open', () => B.send(JSON.stringify({ t: 'join', room: 'main', name: 'あいて' })));
    B.on('message', d => { const m = JSON.parse(d); if (m.t === 'hello'){ bId = m.id; res(); } if (m.t !== 'state') return; const me = m.players.find(p => p.id === bId); if (!me) return;
      if (m.phase === 'lobby' && !me.ready && !f.r){ f.r = 1; B.send(JSON.stringify({ t: 'ready' })); }
      if (m.phase === 'run' && me.status === 'waiting' && !f.s){ f.s = 1; B.send(JSON.stringify({ t: 'start' })); } });
  });
  const bPos = (x, y) => B.send(JSON.stringify({ t: 'pos', x, y }));
  await page.keyboard.press('4'); await until(() => state === 'mp' && MP.snap && MP.snap.phase === 'lobby');
  await connectB(); await until(() => MP.snap.players.length === 2); bPos(420, 420); await sleep(100);
  await move(640, 630); await shot('10-mp-lobby', 'ui', true);
  await page.mouse.click(640, 630); await until(() => MP.snap.phase === 'box');
  const card = await page.evaluate(() => { const c = mpBoxCards()[1]; return { x: c.x + c.w / 2 + 30, y: c.y + c.h - 30 }; });
  bPos(card.x + 260, card.y - 40); await move(card.x, card.y); await shot('11-mp-box', 'ui', true);
  B.send(JSON.stringify({ t: 'pick', i: 0 })); await page.mouse.click(card.x, card.y); await until(() => MP.snap.phase === 'place' && MP.me.pick !== null);
  bPos(900, 200); await move(640, 380); await shot('12-mp-place', 'place');
  await page.mouse.click(640, 380); await sleep(300);
  if (await page.evaluate(() => MP.me && !MP.me.placed)) await page.keyboard.press(' '); // 置けない型だったら捨てる
  await until(() => MP.me.placed); await move(700, 500); await shot('13-mp-placed', 'ui');
  B.send(JSON.stringify({ t: 'pass' })); await until(() => MP.snap.phase === 'count');
  bPos(110, 340); await move(260, 300); await shot('14-mp-count', 'ui');
  await move(90, 370); await until(() => MP.snap.phase === 'run' && MP.status === 'running'); bPos(150, 330);
  await move(130, 400); await shot('15-mp-run', 'game');

  B.close(); await browser.close(); srv.kill();
  console.log(errors.length ? 'CURSOR SHOTS FAIL\n' + errors.join('\n') : 'CURSOR SHOTS OK');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
