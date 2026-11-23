// 振動の見た目を実ブラウザで確かめる（node scripts/shake-shots.js）。test-out/s-*.png
// 見やすいよう強さ ×2 にし、横断レーザーの照射中で揺れが大きい「同じ瞬間」を3通りに描いて撮る。
// カーソルは照射中のレーザー(x=400)のすぐ左 (330,360) に置く。
//   s-1: カーソル周りの固定 ON（カーソルの近くは判定どおりの位置、遠くは揺れている）
//   s-2: 固定 OFF（部屋全体が揺れる。カーソルだけは動かない）
//   s-3: 振動 OFF（基準。判定はこの絵の位置で行われる）
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const root = path.join(__dirname, '..'), out = path.join(root, 'test-out'); fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load/.test(m.text())) errors.push(m.text()); });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.waitForFunction(() => { const c = DAILIES.get(today()); return c && !c.building; });
  await page.mouse.move(160, 600); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 's-0-menu.png') });
  await page.mouse.click(160, 600); await page.waitForFunction(() => state === 'title' && course.lab);
  for (let i = 0; i < 4; i++) await page.keyboard.press(']'); // 強さ ×2
  await page.mouse.move(120, 380); await page.mouse.move(90, 360); await page.waitForFunction(() => state === 'race');
  await page.mouse.move(330, 360, { steps: 12 }); await page.waitForTimeout(200);
  // 実時間の進行を止め、揺れが大きい照射中の時刻を探す
  const te = await page.evaluate(() => {
    window.requestAnimationFrame = () => 0; const room = ROOMS[0];
    for (let t = elapsed + 0.2; t < elapsed + 8; t += 1 / 240){ const o = shakeOffset(roomShake(room.pieces, t), t); if (beamState(room.pieces[0], t).on && o.x > 13 && o.y > 9) return t; }
    return -1;
  });
  if (te < 0) throw new Error('揺れの大きい時刻が見つからない');
  await page.waitForTimeout(150);
  const frame = (name, set) => page.evaluate(([t, set]) => { Object.assign(SHAKE, set); update(goTime + t * 1000); const o = shakeOffset(roomShake(ROOMS[0].pieces, t), t); return { state, deaths, elapsed: +elapsed.toFixed(3), off: [+o.x.toFixed(1), +o.y.toFixed(1)], cur, lens: SHAKE.lens, on: SHAKE.on }; }, [te, set])
    .then(async r => { await page.screenshot({ path: path.join(out, name + '.png') }); console.log(name, JSON.stringify(r)); if (r.state !== 'race' || r.deaths) errors.push(name + ': 判定が変わった ' + JSON.stringify(r)); });
  await frame('s-1-lens-on', { on: true, lens: true });
  await frame('s-2-lens-off', { on: true, lens: false });
  await frame('s-3-shake-off', { on: false, lens: true });
  await browser.close();
  console.log(errors.length ? 'SHAKE SHOTS FAIL\n' + errors.join('\n') : 'SHAKE SHOTS OK');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
