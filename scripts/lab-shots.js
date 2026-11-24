// 要素ラボを実ブラウザで撮る（node scripts/lab-shots.js [番号...]）。test-out/l-00-list.png と l-<番号>.png
// 各要素の部屋に入り、スタートして少し待ってから撮る（カーソルはスタートパッドの上）。番号を渡すとその要素だけ。
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const root = path.join(__dirname, '..'), out = path.join(root, 'test-out'); fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const only = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load/.test(m.text())) errors.push(m.text()); });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.waitForFunction(() => typeof LABS !== 'undefined');
  await page.mouse.move(640, 690); await page.keyboard.press('l'); await page.waitForFunction(() => state === 'lab'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'l-00-list.png') });
  const labs = await page.evaluate(() => LABS.map(e => e.code));
  for (let i = 0; i < labs.length; i++){
    if (only.length && !only.includes(labs[i])) continue;
    await page.evaluate(i => openLab(i), i); await page.waitForFunction(() => state === 'title');
    await page.mouse.move(130, 400); await page.mouse.move(90, 360); await page.waitForFunction(() => state === 'race', null, { timeout: 8000 });
    await page.waitForTimeout(labs[i] === 'TR-8' ? 2300 : 1700);
    const info = await page.evaluate(() => ({ state, deaths })); await page.screenshot({ path: path.join(out, `l-${labs[i]}.png`) });
    console.log(labs[i].padEnd(6), JSON.stringify(info)); if (info.deaths) errors.push(labs[i] + ': スタートパッドの上で死んだ');
    await page.keyboard.press('b'); await page.waitForFunction(() => state === 'lab');
  }
  await browser.close();
  console.log(errors.length ? 'LAB SHOTS FAIL\n' + errors.join('\n') : 'LAB SHOTS OK');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
