// 開発用の調査: 固定コースをBOTが解けるか／デイリー生成の成否・時間・パー・上乗せの分布
//   node scripts/probe.js [日数=30] [開始日=2026-11-23]
const path = require('path');
const { load } = require(path.join(__dirname, '..', 'harness.js'));
const { m } = load(['COURSES', 'solveRoom', 'buildDaily', 'dayShift', 'DAILY', 'ARCH', 'MODS', 'SV', 'roomLabel']);
const days = +(process.argv[2] || 30), from = process.argv[3] || '2026-11-23';

console.log('--- 固定コース（BOTのパー / 人間向けの条件でも通れるか）');
for (const c of m.COURSES){
  let t = 0, pos = c.start; const parts = [];
  for (let i = 0; i < c.rooms.length; i++){
    const r = m.solveRoom(c.rooms[i], pos, c.rooms[i].exit, t, true, 40);
    if (!r.ok){ parts.push(c.rooms[i].name + ' ✗'); t = NaN; break; }
    const hu = m.solveRoom(c.rooms[i], i ? c.rooms[i - 1].exit : c.start, c.rooms[i].exit, t + 2.1, false, 40, m.DAILY.HUMAN).ok;
    parts.push(`${c.rooms[i].name} ${r.time.toFixed(1)}${hu ? '' : '(人✗)'}`); t += r.time; pos = r.path[r.path.length - 1];
  }
  console.log(c.name.padEnd(8), 'par', isNaN(t) ? '--' : t.toFixed(2), '| medals', c.medals.join('/'), '|', parts.join(', '));
}

console.log(`--- デイリー ${days}日ぶん (${from}〜)`);
const use = {}, mods = {}, tierMods = [[0, 0], [0, 0], [0, 0]], tierCps = [0, 0, 0], tierN = [0, 0, 0], tierGold = [0, 0, 0], t0 = Date.now(); let worst = 0, fb = 0;
for (let i = 0; i < days; i++){
  const date = m.dayShift(from, i), s = Date.now(), c = m.buildDaily(date), ms = Date.now() - s, tr = c.daily.tier; worst = Math.max(worst, ms); fb += c.daily.fallbacks; tierN[tr]++; tierGold[tr] += c.medals[0];
  for (const r of c.rooms){ use[r.name] = (use[r.name] || 0) + 1; for (const k of r.mods || []) mods[k] = (mods[k] || 0) + 1; tierMods[tr][0] += (r.mods || []).length; tierMods[tr][1]++; tierCps[tr] += r.cps.length; }
  if (i < 14) console.log(date, m.DAILY.TIER_NAME[tr].padEnd(9), 'par', c.par.toFixed(1).padStart(5), 'medals', c.medals.join('/').padEnd(10), `${ms}ms`.padStart(7), c.rooms.map(r => m.roomLabel(r).replace(/ /g, '')).join(' > '));
}
console.log('平均生成', Math.round((Date.now() - t0) / days), 'ms / 最大', worst, 'ms / 予備部屋', fb);
console.log('段階ごと:', m.DAILY.TIER_NAME.map((n, k) => `${n} 上乗せ ${(tierMods[k][0] / Math.max(1, tierMods[k][1])).toFixed(2)}/部屋 · CP ${(tierCps[k] / Math.max(1, tierMods[k][1])).toFixed(2)}/部屋 · GOLD平均 ${(tierGold[k] / Math.max(1, tierN[k])).toFixed(0)}s`).join(' | '));
console.log('型の出現数', Object.entries(use).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('上乗せの出現数', Object.entries(mods).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
