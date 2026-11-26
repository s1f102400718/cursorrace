// 音と区間差のテスト（node sound.test.js）
//  1) 合図の状態(cueOf): 時刻だけで決まり、横断レーザーは 予告 → 照射 → 静か の順。型ごとの音の割り当て
//  2) 走行中の合図: カウントダウン・GO・部屋の通過・ゴール・障害物の予告と照射が、決まった順と回数で鳴る
//  3) 音は判定に関わらない: 音の 入/切 で、同じ入力から同じ結果（死亡数・タイム・走行記録）になる
//  4) 合成: 代用品の AudioContext で全部の音が例外なく作られ、障害物の音は場面が替わると止まる。設定キー
//  5) 区間差: 同じ走りを2回すると差は 0。速い走り・遅い走りで符号が合う。古い記録（区間タイムなし）はゴーストから求める
//  6) かすり: 動く障害物のそばで数える／壁では数えない／当たっているなら死亡が先
const { load, botPath, runBot } = require('./harness.js');
let fail = 0; const ok = (c, msg) => { if (!c){ fail++; console.log('  NG', msg); } return c; };
const NAMES = ['T', 'SFX', 'CUES', 'CUE', 'LAB', 'LABS', 'COURSES', 'ARCH', 'RNG', 'frame', 'prims', 'hit', 'sweepHit', 'solveRoom', 'cueOf', 'cueSound', 'hazardCues', 'grazeHit', 'splitsOf', 'sfx', 'sfxUnlock', 'sfxHush', 'soundKey',
  'openLab', 'openBoard', 'play', 'restart', 'update', 'samples', 'state', 'deaths', 'finalTime', 'lastRun', 'cur', 'course', 'best', 'pbSplits', 'splitPop', 'splits', 'grazes', 'loadRec', 'saveRec', 'boardKey', 'loadBest', 'H'];

// AudioContext の代用品。作られた音源の数と、つないだ先を覚える
function mockAudio(){
  const log = { ctx: 0, osc: 0, noise: 0, started: 0, stopped: 0, gains: [], resumed: 0 };
  const param = v => ({ value: v, setValueAtTime(x){ this.value = x; }, exponentialRampToValueAtTime(x, t){ if (!(x > 0) || !isFinite(t)) throw new Error('bad ramp ' + x + ' ' + t); }, setTargetAtTime(x){ this.target = x; } });
  const node = extra => ({ to: [], connect(d){ if (!d) throw new Error('connect to nothing'); this.to.push(d); return d; }, ...extra });
  class AC {
    constructor(){ log.ctx++; this.state = 'running'; this.currentTime = 0; this.sampleRate = 8000; this.destination = node({ dest: true }); }
    resume(){ log.resumed++; this.state = 'running'; }
    createGain(){ const g = node({ gain: param(1) }); log.gains.push(g); return g; }
    createDynamicsCompressor(){ return node({}); }
    createStereoPanner(){ return node({ pan: param(0) }); }
    createBiquadFilter(){ return node({ type: '', Q: param(1), frequency: param(0) }); }
    createOscillator(){ log.osc++; return node({ type: '', frequency: param(0), start(t){ if (!isFinite(t)) throw new Error('bad start'); log.started++; }, stop(t){ if (!isFinite(t)) throw new Error('bad stop'); log.stopped++; } }); }
    createBuffer(ch, len){ const d = new Float32Array(len); return { getChannelData: () => d }; }
    createBufferSource(){ log.noise++; return node({ buffer: null, loop: false, start(){ log.started++; }, stop(){ log.stopped++; } }); }
  }
  return { AC, log };
}

// 振動ラボ（横断レーザー3部屋）をBOTで完走する
function runLab(soundOn, AC){
  const G = load(NAMES, { AudioContext: AC }), m = G.m;
  m.SFX.on = soundOn; m.SFX.trace = []; if (AC) m.sfxUnlock();
  const b = botPath(m, m.LAB.rooms, m.LAB.start); if (b.fail !== undefined) return { solved: false };
  m.openLab(); const done = runBot(m, G.clock, b.bot);
  return { solved: true, done, G, m, deaths: m.deaths, time: m.finalTime, rec: JSON.stringify(m.lastRun && m.lastRun.s), trace: m.SFX.trace.slice() };
}

(() => {
  const { m } = load(NAMES);

  console.log('1) 合図の状態');
  const beam = { t: 'beam', x: 400, y: 360, deg: 90, thick: 16, warn: 0.8, on: 0.9, off: 1.5, phase: 0 };
  ok(m.cueOf(beam, 0.4) === 'w' && m.cueOf(beam, 1.0) === 'f' && m.cueOf(beam, 2.2) === '' && m.cueOf(beam, 3.3) === 'w', '横断レーザーが 予告 → 照射 → 静か にならない');
  ok(m.cueSound(beam, 'w') === 'warn' && m.cueSound(beam, 'f') === 'laser', '横断レーザーの音の割り当て');
  const F = m.frame(1, false), pieces = [...m.LAB.rooms.flatMap(r => r.pieces), ...m.LABS.flatMap(e => e.rooms.flatMap(r => r.pieces)), ...m.COURSES.flatMap(c => c.rooms.flatMap(r => r.pieces))];
  for (const name of Object.keys(m.ARCH)) pieces.push(...m.ARCH[name](m.RNG('sound|' + name), 0.8, F).pieces);
  pieces.push({ id: 'a', t: 'aimed', x: 640, y: 110, speed: 340, interval: 0.9, r: 6, life: 4 }, { id: 'h', t: 'mine', x: 500, y: 300, trigger: 70, fuse: 0.5, blast: 90, hold: 0.3, cooldown: 2 });
  const types = new Set(), sounds = new Set(); let bad = 0, unstable = 0;
  for (const p of pieces){
    let prev;
    for (let t = 0; t < 12; t += 0.013){
      const v = m.cueOf(p, t); if (v !== null && typeof v !== 'string') bad++;
      if (v === null) break; types.add(p.t);
      if (v !== m.cueOf(p, t)) unstable++;                                    // 同じ時刻なら同じ答え
      if (prev !== undefined && v !== prev && v){ const s = m.cueSound(p, v); if (!s || !m.CUES[s]) bad++; else sounds.add(s); }
      prev = v;
    }
  }
  ok(bad === 0, `合図の値か音の割り当てがおかしい ${bad} 回`); ok(unstable === 0, '時刻だけで決まっていない');
  ok(types.size >= 10, '音の付く型が少ない: ' + [...types]); ok(['warn', 'laser', 'zap', 'shot', 'slam'].every(s => sounds.has(s)), '鳴らない音がある: ' + [...sounds]);
  const wall = { t: 'wall', x: 0, y: 0, w: 10, h: 10 }; ok(m.cueOf(wall, 1) === null, '壁に音が付いている');
  console.log(`   ${pieces.length}個のうち音の付く型 ${types.size}種 / 鳴った音 ${[...sounds].join(' ')}`);

  console.log('2) 走行中の合図');
  const A = runLab(true), B = runLab(false);
  if (ok(A.solved && A.done && B.done, 'ラボをBOTが完走しない')){
    const cnt = n => A.trace.filter(x => x === n).length, rooms = A.m.LAB.rooms.length;
    ok(A.trace[0] === 'tick' && A.trace.indexOf('go') > 0 && cnt('tick') === Math.ceil(A.m.T.COUNTDOWN) && cnt('go') === 1, 'カウントダウンと GO: ' + A.trace.slice(0, 5));
    ok(cnt('room') === rooms - 1 && cnt('finish') === 1 && A.trace[A.trace.length - 1] === 'finish', `部屋の通過 ${cnt('room')} / ゴール ${cnt('finish')}`);
    ok(cnt('warn') > 0 && cnt('laser') > 0, `障害物の音が鳴らない: 予告 ${cnt('warn')} / 照射 ${cnt('laser')}`);
    ok(cnt('die') === 0 && A.deaths === 0, '死んでいないのに死亡音');
    // 部屋に入った時点ですでに予告中のレーザーは、予告音なしで照射音が鳴る（途中から予告は鳴らさない）。だから順番までは問わない
    console.log(`   ${A.trace.length}回: tick ${cnt('tick')} go ${cnt('go')} warn ${cnt('warn')} laser ${cnt('laser')} room ${cnt('room')} graze ${cnt('graze')} finish ${cnt('finish')}`);

    console.log('3) 音は判定に関わらない');
    ok(B.trace.length === 0, '切なのに合図が出た');
    ok(A.time === B.time && A.rec === B.rec && A.deaths === B.deaths, '音の入/切で結果が変わった');
    ok(A.G.errors.length === 0 && B.G.errors.length === 0, '例外: ' + A.G.errors.concat(B.G.errors)[0]);
  }

  console.log('4) 合成と設定');
  const { AC, log } = mockAudio(), S = runLab(true, AC);
  if (ok(S.solved && S.done, '音を合成しながら完走しない')){
    ok(log.ctx === 1 && log.osc > 10 && log.noise > 0 && log.started === log.osc + log.noise, `音源: 発振 ${log.osc} 雑音 ${log.noise} 開始 ${log.started}`);
    ok(S.m.SFX.err === undefined, '合成中の例外: ' + (S.m.SFX.err && S.m.SFX.err.stack));
    ok(S.time === A.time && S.rec === A.rec, '合成の有無で結果が変わった');
    const sm = S.m; let threw = '';
    for (const name of Object.keys(sm.CUES)){ try { sm.CUES[name]({ g: 0.7, pan: -0.4, n: 3, dur: 1.2, bus: sm.SFX.hz }); sm.CUES[name]({ g: 1 }); } catch (e) { threw += name + ': ' + e.message + ' '; } }
    ok(!threw, '作れない音: ' + threw);
    // 場面が替わると、障害物の音の行き先を取り替えて前のを絞る
    const beamP = { t: 'beam', x: 400, y: 360, deg: 90, thick: 16, warn: 0.8, on: 0.9, off: 1.5, phase: 0 };
    sm.hazardCues('t/0', [beamP], 0.4, null); const bus0 = sm.SFX.hz, n0 = log.osc;
    sm.hazardCues('t/0', [beamP], 1.0, null); ok(log.osc > n0, '照射の瞬間に音が作られない');
    sm.hazardCues('t/0', [beamP], 1.1, null); const n1 = log.osc; sm.hazardCues('t/0', [beamP], 1.2, null); ok(log.osc === n1, '照射中に鳴り直した');
    sm.hazardCues(null); ok(sm.SFX.hz !== bus0 && bus0.gain.target === 0, '場面が替わっても障害物の音が止まらない');
    sm.hazardCues('t/1', [beamP], 1.0, null); ok(log.osc === n1, '場面に入った最初のフレームで鳴った（途中から鳴らさない）');
    // 設定キー
    ok(sm.soundKey('s') && sm.SFX.on === false && S.G.store.get('cursorrun.sound') === '0' && sm.SFX.out.gain.value === 0, 'S で切れない');
    const c0 = log.osc; sm.sfx('die'); ok(log.osc === c0, '切なのに鳴った');
    ok(sm.soundKey('s') && sm.SFX.on === true && sm.SFX.out.gain.value === sm.SFX.vol, 'S で戻らない');
    for (let i = 0; i < 20; i++) sm.soundKey(','); ok(sm.SFX.vol === 0 && S.G.store.get('cursorrun.vol') === '0', '音量の下限');
    for (let i = 0; i < 20; i++) sm.soundKey('.'); ok(sm.SFX.vol === 1 && sm.SFX.out.gain.value === 1, '音量の上限');
    ok(!sm.soundKey('q'), '関係ないキーを食べた');
    const R = load(NAMES, { store: S.G.store }); ok(R.m.SFX.on === true && R.m.SFX.vol === 1, '設定を覚えていない');
  }

  console.log('5) 区間差');
  {
    const G = load(NAMES), g = G.m, c = g.COURSES[0], b = botPath(g, c.rooms, c.start);
    if (ok(b.fail === undefined, 'NORMAL をBOTが解けない')){
      const run = (bot) => { g.openBoard(c); g.play(); const pops = []; let last = null;
        g.samples.push({ x: bot[2], y: bot[3] }); G.clock.t += 16; g.update(G.clock.t);
        for (let i = 0; i < 400 && g.state === 'count'; i++){ G.clock.t += 16; g.update(G.clock.t); }
        const t0 = G.clock.t; let lt = -1;
        for (let i = 0; i < bot.length && g.state === 'race'; i += 5){ if (bot[i] === lt) continue; lt = bot[i]; G.clock.t = t0 + bot[i]; g.samples.push({ x: bot[i + 2], y: bot[i + 3] }); g.update(G.clock.t); if (g.splitPop && g.splitPop !== last){ last = g.splitPop; pops.push(last.d); } }
        return { done: g.state === 'done', pops, splits: g.splits.slice(), html: g.H.msg.innerHTML }; };
      const slow = b.bot.map((v, i) => i % 5 === 0 ? Math.round(v * 1.25) : v);   // 同じ道を 1.25 倍の時間で（障害物の時刻がずれるので完走は保証しない）
      const r1 = run(b.bot);
      ok(r1.done && r1.pops.length === 0, `1回目（自己ベストなし）で差が出た: ${r1.pops}`);
      const rec = g.loadRec(g.boardKey(c)); ok(rec && rec.sp && rec.sp.length === c.rooms.length && rec.sp[rec.sp.length - 1] === rec.t, '記録に区間タイムが入っていない');
      const r2 = run(b.bot);
      ok(r2.done && r2.pops.length === c.rooms.length && r2.pops.every(d => Math.abs(d) < 0.002), `同じ走りの差が 0 にならない: ${r2.pops}`);
      ok(g.pbSplits.length === c.rooms.length && g.pbSplits.every((v, i) => Math.abs(v - r1.splits[i]) < 0.001), '自己ベストの区間タイムが1回目と違う');
      ok(/graze/.test(r2.html) && (r2.html.match(/<b style/g) || []).length === c.rooms.length, '結果画面に区間ごとの差が出ない');
      // 古い記録（区間タイムなし）はゴーストから。途中の区間は記録の粗さ（このテストは BOT の刻みが粗いので 0.06 秒）まで許し、最後の区間は記録のタイムと一致
      const old = { ...rec }; delete old.sp; g.saveRec(g.boardKey(c), old);
      const fromGhost = g.splitsOf(g.loadBest(c)), nG = c.rooms.length;
      ok(fromGhost && fromGhost.length === nG && fromGhost.every((v, i) => Math.abs(v - r1.splits[i]) < 0.06) && fromGhost[nG - 1] === rec.t / 1000, `ゴーストから求めた区間タイムがずれる: ${fromGhost} / ${r1.splits}`);
      // 自己ベストを 0.5 秒遅かったことにすると、同じ走りは全区間で −0.5、ゴールは NEW BEST の音
      g.saveRec(g.boardKey(c), { ...rec, t: rec.t + 500, sp: rec.sp.map(v => v + 500) });
      g.SFX.trace = []; const r4 = run(b.bot);
      ok(r4.done && r4.pops.length === nG && r4.pops.every(d => Math.abs(d + 0.5) < 0.002), `速い走りの差が −0.5 にならない: ${r4.pops}`);
      ok(g.SFX.trace.filter(x => x === 'ahead').length === nG && g.SFX.trace.includes('best') && !g.SFX.trace.includes('behind'), '速いときの音: ' + g.SFX.trace.filter(x => /ahead|behind|best|finish/.test(x)));
      ok(g.loadRec(g.boardKey(c)).t === rec.t, '速い走りで記録が更新されない');
      // 遅い走り: 完走できたら、差は全部プラスで、最後の差 = タイムの差
      const r3 = run(slow);
      if (r3.done) ok(r3.pops.length === c.rooms.length && r3.pops.every(d => d > 0) && Math.abs(r3.pops[r3.pops.length - 1] - (g.finalTime - rec.t / 1000)) < 0.002, `遅い走りの差: ${r3.pops}`);
      console.log(`   区間 ${r1.splits.map(v => v.toFixed(2)).join(' / ')} · 同じ走りの差 ${r2.pops.map(v => v.toFixed(3)).join(' ')} · 遅い走り ${r3.done ? r3.pops.map(v => '+' + v.toFixed(2)).join(' ') : '完走せず（差の確認は省略）'}`);
    }
  }

  console.log('6) かすり');
  {
    const R = m.T.HEAD_R + m.T.GRAZE_R, ball = { k: 'circ', x: 300, y: 300, r: 20, c: 'haz' }, wl = { k: 'rect', x: 500, y: 0, w: 40, h: 720, c: 'wall' }, off = { k: 'cap', ax: 0, ay: 100, bx: 1280, by: 100, r: 6, c: 'laser', on: false };
    ok(!!m.grazeHit([ball], { x: 300 + 20 + R - 1, y: 300 }) && !m.grazeHit([ball], { x: 300 + 20 + R + 1, y: 300 }), 'かすりの距離');
    ok(!m.grazeHit([wl], { x: 495, y: 300 }), '壁でかすった'); ok(!m.grazeHit([off], { x: 600, y: 102 }), '消えているレーザーでかすった');
    ok(!!m.sweepHit([ball], 318, 300, 318, 300) , '当たっている位置（死亡が先）');
  }

  console.log(fail ? `SOUND FAIL ${fail}` : 'SOUND OK');
  process.exit(fail ? 1 : 0);
})();
