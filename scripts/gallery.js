// 指定した日付のデイリーを実寸で撮る（node scripts/gallery.js 2026-11-28 2026-12-06 ...）。
// サーバーなし（file://）で開くので、端末だけで動くときの表示確認も兼ねる。test-out/g-<日付>-<部屋>.png
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const root = path.join(__dirname, '..'), out = path.join(root, 'test-out'); fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const dates = process.argv.slice(2).length ? process.argv.slice(2) : ['2026-11-28'];
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.waitForFunction(() => { const c = DAILIES.get(today()); return c && !c.building; });
  for (const date of dates){
    const info = await page.evaluate(d => { const c = buildDaily(d); c.bot = decodeGhost(encodeGhost(c.bot, c.par * 1000)); openBoard(c); return { rooms: c.rooms.map(r => r.name), tier: c.daily.tier, par: c.par, medals: c.medals, cps: c.rooms.map(r => r.cps.length) }; }, date);
    console.log(date, JSON.stringify(info));
    await page.mouse.move(300, 420); await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `g-${date}-0board.png`) });
    for (let i = 0; i < info.rooms.length; i++){
      await page.evaluate(i => { play(); enterRoom(i); document.getElementById('msg').innerHTML = ''; }, i);
      await page.mouse.move(640, 700); await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(out, `g-${date}-${i + 1}${info.rooms[i]}.png`) });
      await page.evaluate(() => openBoard(course));
    }
  }
  await browser.close();
  console.log(errors.length ? 'GALLERY FAIL\n' + errors.join('\n') : 'GALLERY OK');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
