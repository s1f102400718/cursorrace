// 開発用の調査: 固定コースをBOTが解けるか／デイリー生成の成否・時間・パーの分布
//   node scripts/probe.js [日数=30] [開始日=2026-11-23]
const path = require('path');
const { load } = require(path.join(__dirname, '..', 'harness.js'));
const { m } = load(['COURSES', 'solveRoom', 'buildDaily', 'dayShift', 'DAILY', 'ARCH', 'SV']);
const days = +(process.argv[2] || 30), from = process.argv[3] || '2026-11-23';

console.log('--- 固定コース（BOTのパー）');
for (const c of m.COURSES){
  let t = 0, pos = c.start; const parts = [];
  for (let i = 0; i < c.rooms.length; i++){
    const r = m.solveRoom(c.rooms[i], pos, c.rooms[i].exit, t, true, 40);
    if (!r.ok){ parts.push(c.rooms[i].name + ' ✗'); t = NaN; break; }
    parts.push(`${c.rooms[i].name} ${r.time.toFixed(1)}`); t += r.time; pos = r.path[r.path.length - 1];
  }
  console.log(c.name.padEnd(8), 'par', isNaN(t) ? '--' : t.toFixed(2), '| medals', c.medals.join('/'), '|', parts.join(', '));
}

console.log(`--- デイリー ${days}日ぶん (${from}〜)`);
const use = {}, t0 = Date.now(); let worst = 0, fb = 0, parSum = 0;
for (let i = 0; i < days; i++){
  const date = m.dayShift(from, i), s = Date.now(), c = m.buildDaily(date), ms = Date.now() - s; worst = Math.max(worst, ms); fb += c.daily.fallbacks; parSum += c.par;
  for (const r of c.rooms) use[r.name] = (use[r.name] || 0) + 1;
  if (i < 14) console.log(date, m.DAILY.TIER_NAME[c.daily.tier].padEnd(6), 'par', c.par.toFixed(1).padStart(5), 'medals', c.medals.join('/').padEnd(9), `${ms}ms`.padStart(7), c.rooms.map(r => r.name).join(' > '));
}
console.log('平均生成', Math.round((Date.now() - t0) / days), 'ms / 最大', worst, 'ms / 予備部屋', fb, '/ 平均パー', (parSum / days).toFixed(1));
console.log('型の出現数', Object.entries(use).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
