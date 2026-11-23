// 開発用: ソルバーの条件（速度V・余白M）を変えて、手作りコースのパーがどう変わるかを見る
const path = require('path');
const { load } = require(path.join(__dirname, '..', 'harness.js'));
const { m } = load(['COURSES', 'solveRoom']);
for (const prof of [{ V: 500, M: 16 }, { V: 400, M: 24 }, { V: 350, M: 28 }, { V: 300, M: 32 }, { V: 300, M: 36 }, { V: 250, M: 40 }]){
  const out = [];
  for (const c of m.COURSES){
    let t = 0, pos = c.start, bad = ''; const parts = [];
    for (let i = 0; i < c.rooms.length; i++){ const r = m.solveRoom(c.rooms[i], pos, c.rooms[i].exit, t, true, 60, prof); if (!r.ok){ bad = c.rooms[i].name; break; } parts.push(r.time.toFixed(1)); t += r.time; pos = r.path[r.path.length - 1]; }
    out.push(c.name + ' ' + (bad ? '✗' + bad : t.toFixed(1)) + ' [' + parts.join(' ') + ']');
  }
  console.log(`V${prof.V} M${prof.M}:`, out.join(' | '));
}
