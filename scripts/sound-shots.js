// 音と区間差を実ブラウザで確かめる（node scripts/sound-shots.js）。test-out/s-*.png
//   1) 最初のキーで音の用意ができ、合図ごとに実際に波形が出る（出口に測定器をつないで山を測る）
//   2) NORMAL を遅い BOT で完走（自己ベスト）→ 速い BOT でもう一度: 部屋を抜けた瞬間の差の表示と、結果画面の区間ごとの差を撮る
//   3) S で音を切ると出口の音量が 0 になる
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const root = path.join(__dirname, '..'), out = path.join(root, 'test-out'), PORT = 8128, BASE = `http://localhost:${PORT}/`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorrun-snd-'));
fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('server:')) res(); }));
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => { try { localStorage.setItem('cursorrun.seen', '1'); } catch (e) {} }); // 初回の「あそびかた」は出さない
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });
  const check = (c, msg) => { console.log((c ? 'ok  ' : 'NG  ') + msg); if (!c) errors.push(msg); };

  await page.goto(BASE + '?name=' + encodeURIComponent('じぶん'));
  await until(() => { const c = DAILIES.get(today()); return c && !c.building; });
  check(await page.evaluate(() => SFX.ac === null && SFX.on === true), '操作の前は音の用意をしていない（既定は ON）');
  await page.mouse.move(420, 400);
  await page.keyboard.press('1'); await until(() => state === 'board');
  await until(() => SFX.ac && SFX.ac.state === 'running');
  check(true, '最初のキーで音の用意ができた（state = running）');

  // ---- 1) 合図ごとに波形が出るか。出口に測定器をつなぎ、鳴らしてから山の高さを測る ----
  const peaks = await page.evaluate(async () => {
    const an = SFX.ac.createAnalyser(); an.fftSize = 2048; SFX.out.connect(an);
    const buf = new Float32Array(an.fftSize), res = {};
    const listen = async ms => { let pk = 0; const end = performance.now() + ms; while (performance.now() < end){ an.getFloatTimeDomainData(buf); for (const v of buf) pk = Math.max(pk, Math.abs(v)); await new Promise(r => setTimeout(r, 12)); } return pk; };
    res.silence = await listen(150);
    for (const name of Object.keys(CUES)){ SFX.last = {}; sfx(name, { g: 1, pan: 0, n: 1, dur: 0.3, bus: SFX.hz }); res[name] = await listen(name === 'ahead' || name === 'behind' || name === 'best' ? 520 : 260); await new Promise(r => setTimeout(r, 380)); }
    // 障害物の音は、場面が替わるとすぐ止まる
    SFX.last = {}; sfx('laser', { g: 1, pan: 0, dur: 2.5, bus: SFX.hz }); await listen(200); sfxHush(); await new Promise(r => setTimeout(r, 300)); res.afterHush = await listen(150);
    res.err = SFX.err ? String(SFX.err) : '';
    return res;
  });
  const names = Object.keys(peaks).filter(k => !['silence', 'afterHush', 'err'].includes(k));
  console.log('    山の高さ: ' + names.map(k => `${k} ${peaks[k].toFixed(2)}`).join(' · '));
  check(peaks.silence < 0.005, `鳴らしていないときは無音（${peaks.silence.toFixed(4)}）`);
  check(names.every(k => peaks[k] > 0.01), '全部の合図で波形が出る: ' + names.filter(k => !(peaks[k] > 0.01)).join(' '));
  check(names.every(k => peaks[k] < 0.95), '割れるほど大きい音がない: ' + names.filter(k => !(peaks[k] < 0.95)).join(' '));
  check(peaks.afterHush < 0.01, `場面が替わると照射音が止まる（残り ${peaks.afterHush.toFixed(4)}）`);
  check(!peaks.err, '合成の例外なし ' + peaks.err);

  // ---- 2) 区間差。実時間だとフレームの揺れで死ぬことがあるので、走る間だけ時刻を手で進める ----
  await page.keyboard.press('Enter'); await until(() => state === 'title');
  const runBot = (prof, stopAfterRoom) => page.evaluate(async ([prof, stopAfterRoom]) => {
    const raf = window.__raf || (window.__raf = window.requestAnimationFrame); window.requestAnimationFrame = () => 0;
    await new Promise(r => raf(() => raf(r))); // 予約済みの本物の1フレームを先に流しておく（後から走ると、手で進めた画面を上書きしてしまう）
    const bot = []; let tt = 0, pos = course.start;
    for (let i = 0; i < ROOMS.length; i++){ const s = solveRoom(ROOMS[i], pos, ROOMS[i].exit, tt, true, 40, prof || undefined); if (!s.ok) return { fail: i }; for (const p of s.path) bot.push(Math.round(p.t * 1000), i, p.x, p.y, 1); tt += s.time; pos = s.path[s.path.length - 1]; }
    let t = performance.now() - 60000; // 過去の時刻で回す（実時間に戻したとき時刻が逆行しないように）
    samples.push({ x: bot[2], y: bot[3] }); update(t += 16);
    for (let i = 0; i < 400 && state === 'count'; i++) update(t += 16);
    const t0 = t; let last = -1, stopped = false;
    for (let i = 0; i < bot.length && state === 'race'; i += 5){
      if (bot[i] === last) continue; last = bot[i]; t = t0 + bot[i]; samples.push({ x: bot[i + 2], y: bot[i + 3] }); update(t);
      if (stopAfterRoom !== null && roomIdx === stopAfterRoom + 1 && splitPop){ for (let k = 0; k < 24; k++) update(t += 16); stopped = true; break; } // 差の表示が落ち着くまで少し進めて止める（画面は最後に描いたまま残る）
    }
    if (!stopped){ window.requestAnimationFrame = raf; raf(loop); }
    return { state, deaths, finalTime, stopped, pop: splitPop && splitPop.d, counts: { ...SFX.count } };
  }, [prof, stopAfterRoom]);
  const slow = { V: 400, M: 22, G: 16 };
  const r1 = await runBot(slow, null);
  check(r1.state === 'done' && r1.deaths === 0, '1回目（遅い BOT）で完走: ' + JSON.stringify({ t: r1.finalTime, d: r1.deaths }));
  await sleep(400); await page.screenshot({ path: path.join(out, 's-01-first-done.png') });
  await page.keyboard.press('r'); await until(() => state === 'title');
  const r2 = await runBot(null, 0);
  check(r2.stopped && r2.pop < 0, `2回目（速い BOT）: 最初の部屋を抜けた瞬間の差 ${r2.pop === null ? 'なし' : r2.pop.toFixed(2)}`);
  await page.screenshot({ path: path.join(out, 's-02-split-pop.png') });
  await page.screenshot({ path: path.join(out, 's-02-split-pop-zoom.png'), clip: { x: 440, y: 20, width: 400, height: 110 } });
  await page.evaluate(() => { window.requestAnimationFrame = window.__raf; window.__raf(loop); }); await sleep(200);
  await page.keyboard.press('r'); await until(() => state === 'title');
  const r3 = await runBot(null, null);
  check(r3.state === 'done' && r3.deaths === 0 && r3.finalTime < r1.finalTime, `3回目（速い BOT）で自己ベスト更新: ${r1.finalTime.toFixed(2)} → ${r3.finalTime.toFixed(2)}`);
  await until(() => /NEW BEST/.test(document.getElementById('msg').textContent)); await sleep(400);
  const res = await page.evaluate(() => ({ deltas: [...document.querySelectorAll('#msg .res b')].map(b => b.textContent), text: document.getElementById('msg').textContent, keys: document.getElementById('keys').textContent }));
  check(res.deltas.length === 4 && res.deltas.every(d => d[0] === '−'), '結果画面に区間ごとの差（全部マイナス）: ' + res.deltas.join(' '));
  check(/graze/.test(res.text) && /S 音/.test(res.keys), '結果にかすりの数、キーの案内に S 音');
  await page.screenshot({ path: path.join(out, 's-03-done-deltas.png') });
  console.log('    鳴った合図: ' + JSON.stringify(r3.counts));
  check(r3.counts.tick >= 2 && r3.counts.go >= 1 && r3.counts.room >= 3 && r3.counts.best >= 1 && r3.counts.ahead >= 1, '走行の合図が数どおり');

  // ---- 3) 設定 ----
  await page.keyboard.press('s'); check(await page.evaluate(() => SFX.on === false && SFX.out.gain.value === 0 && localStorage.getItem('cursorrun.sound') === '0'), 'S で音が切れる（出口の音量 0、端末に保存）');
  await sleep(300); await page.screenshot({ path: path.join(out, 's-04-sound-off.png') });
  await page.keyboard.press('s'); check(await page.evaluate(() => SFX.on === true && Math.abs(SFX.out.gain.value - SFX.vol) < 1e-6), 'もう一度 S で戻る');
  check(await page.evaluate(() => !SFX.err), '最後まで合成の例外なし');

  await browser.close(); srv.kill();
  console.log(errors.length ? 'SOUND SHOTS FAIL\n' + errors.join('\n') : 'SOUND SHOTS OK');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
