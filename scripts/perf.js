// 描画の重さを測る（node scripts/perf.js）。立体表示 ON / OFF で、重い部屋を実ブラウザで 3 秒ずつ走らせ、
// 1コマにかかった時間（requestAnimationFrame の間隔）の平均と最悪を出す。ヘッドレスなので絶対値は目安、比べるのは ON と OFF の差。
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const root = path.join(__dirname, '..');
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.waitForFunction(() => typeof LABS !== 'undefined');
  const measure = (code, depth) => page.evaluate(async ([code, depth]) => {
    LOOK.depth = depth; openLab(LABS.findIndex(e => e.code === code));
    const dts = []; let last = performance.now();
    await new Promise(res => { const tick = now => { dts.push(now - last); last = now; if (dts.length < 180) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
    dts.splice(0, 20); dts.sort((a, b) => a - b);
    return { avg: +(dts.reduce((a, b) => a + b, 0) / dts.length).toFixed(1), p95: +dts[Math.floor(dts.length * 0.95)].toFixed(1), max: +dts[dts.length - 1].toFixed(1) };
  }, [code, depth]);
  for (const code of ['DM-3', 'DM-1', 'MV-7', 'MV-11', 'SK-1']){
    const on = await measure(code, true), off = await measure(code, false);
    console.log(code.padEnd(6), '立体ON', JSON.stringify(on), '| OFF', JSON.stringify(off));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
