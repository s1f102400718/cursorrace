const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const el = () => ({ textContent: '', innerHTML: '', hidden: false, addEventListener(){}, getContext: () => new Proxy({}, { get: (t, k) => k === 'measureText' ? () => ({ width: 0 }) : () => {} }), width: 0, height: 0 });
global.document = { getElementById: el, documentElement: {}, addEventListener(){} };
global.window = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, addEventListener(){} };
global.getComputedStyle = () => ({ getPropertyValue: () => '#000' });
global.localStorage = { getItem: () => null, setItem(){} };
global.performance = { now: () => 0 }; global.requestAnimationFrame = () => {};
const m = new Function(js + ';return {prims,sweepHit,COURSES,T};')();
let fail = 0;
for (const c of m.COURSES){
  for (let ri = 0; ri < c.rooms.length; ri++){
    const room = c.rooms[ri], entry = ri === 0 ? c.start : c.rooms[ri - 1].exit, pads = [entry, room.exit, ...room.cps];
    // 1) pads clear of hazards over time
    let bad = 0;
    for (let t = 0; t < 8; t += 0.02){ const ps = m.prims(room, t);
      for (const p of pads) for (let a = 0; a < 12; a++){ const x = p.x + Math.cos(a / 12 * 6.283) * m.T.PAD_R * 0.8, y = p.y + Math.sin(a / 12 * 6.283) * m.T.PAD_R * 0.8; if (m.sweepHit(ps, x, y, x, y)) bad++; } }
    // 2) static walls allow a path entry->exit (grid BFS, 8px cells, walls only)
    const walls = m.prims({ pieces: room.pieces.filter(p => p.t === 'wall') }, 0);
    const cs = 8, W = Math.floor(1280 / cs), Hh = Math.floor(720 / cs), seen = new Uint8Array(W * Hh);
    const free = (i, j) => { const x = i * cs + cs / 2, y = j * cs + cs / 2; return !m.sweepHit(walls, x, y, x, y); };
    const si = Math.floor(entry.x / cs), sj = Math.floor(entry.y / cs), ei = Math.floor(room.exit.x / cs), ej = Math.floor(room.exit.y / cs);
    const q = [[si, sj]]; seen[sj * W + si] = 1; let ok = false;
    while (q.length){ const [i, j] = q.shift(); if (i === ei && j === ej){ ok = true; break; }
      for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]){ const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= W || b >= Hh || seen[b * W + a]) continue; seen[b * W + a] = 1; if (free(a, b)) q.push([a, b]); } }
    // 3) min static corridor width along the way is not tested; report hazard count
    const line = `${c.name.padEnd(8)} ${String(ri + 1)} ${room.name.padEnd(10)} padOverlap=${bad} staticPath=${ok} pieces=${room.pieces.length}`;
    console.log(line); if (bad || !ok) fail++;
  }
}
console.log(fail ? `FAIL ${fail}` : 'ALL OK');
