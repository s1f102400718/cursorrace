// index.html のマルチ処理を node 上で実サーバーに接続して1ラウンド回す煙テスト
const fs = require('fs'), { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 8124;
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const el = () => ({ textContent: '', innerHTML: '', hidden: false, addEventListener(){}, getContext: () => new Proxy({ roundRect: () => {} }, { get: (t, k) => k in t ? t[k] : k === 'measureText' ? () => ({ width: 0 }) : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => ({ addColorStop(){} }) : () => {} }), width: 0, height: 0 });
global.document = { getElementById: el, documentElement: {}, addEventListener(){} };
global.window = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, addEventListener(){} };
global.getComputedStyle = () => ({ getPropertyValue: () => '#000' });
global.localStorage = { getItem: () => null, setItem(){} };
let t = 0; global.performance = { now: () => t }; global.requestAnimationFrame = () => {};
global.location = { protocol: 'http:', host: 'localhost:' + PORT, search: '?name=A' };
global.WebSocket = WebSocket; global.URLSearchParams = URLSearchParams;
const errors = []; global.console = { ...console, error: e => errors.push(String(e && e.stack || e)) };
const C = new Function(js + ';return { mpEnter, update, MP, clicks, ups, samples, get state(){ return state; } };')();

const srv = spawn(process.execPath, [__dirname + '/server.js'], { env: { ...process.env, FAST: '1', PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
let B, seen = [], done = false;
function fakeB(){
  const ws = new WebSocket(`ws://localhost:${PORT}`); let id = null, f = {};
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: 'main', name: 'B' })));
  ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'hello') id = m.id; if (m.t !== 'state') return; const me = m.players.find(p => p.id === id); if (!me) return;
    if (m.phase === 'lobby' && !me.ready && m.players.length >= 2 && !f.r){ f.r = 1; ws.send(JSON.stringify({ t: 'ready' })); }
    if (m.phase === 'box' && me.pick === null && !f.p){ f.p = 1; ws.send(JSON.stringify({ t: 'pick', i: m.box.length - 1 })); }
    if (m.phase === 'place' && !me.placed && !f.pl){ f.pl = 1; ws.send(JSON.stringify({ t: 'place', x: 640, y: 420, w: 200, h: 160 })); }
    if (m.phase === 'run' && me.status === 'waiting' && !f.s){ f.s = 1; ws.send(JSON.stringify({ t: 'start' })); setTimeout(() => ws.send(JSON.stringify({ t: 'dead', by: null })), 80); } });
  return ws;
}
srv.stdout.on('data', d => { if (String(d).includes('server:') && !B){ C.mpEnter(); B = fakeB(); } });
const path = [{ x: 90, y: 360 }, { x: 300, y: 600 }, { x: 700, y: 600 }, { x: 700, y: 100 }, { x: 1000, y: 100 }, { x: 1190, y: 360 }];
let pi = 0, flags = {};
const iv = setInterval(() => {
  t += 16;
  const s = C.MP.snap, phase = s ? s.phase : null;
  if (phase && seen[seen.length - 1] !== phase) seen.push(phase);
  if (phase === 'lobby' && !flags.ready && s.players.length >= 2){ flags.ready = 1; C.clicks.push({ x: 640, y: 630 }); }
  if (phase === 'box' && C.MP.me && C.MP.me.pick === null && !flags.pick){ flags.pick = 1; C.clicks.push({ x: 420, y: 370 }); C.clicks.push({ x: 640, y: 370 }); }
  if (phase === 'place' && C.MP.me && !C.MP.me.placed && !flags.place){ flags.place = 1; C.clicks.push({ x: 1190, y: 360 }); C.ups.push({ x: 1190, y: 360 }); C.clicks.push({ x: 640, y: 300 }); C.ups.push({ x: 640, y: 300 }); }
  if (phase === 'count' || phase === 'run'){ if (pi === 0 || (phase === 'run' && C.MP.status === 'running' && pi < path.length)) { C.samples.push(path[pi]); if (phase === 'run' && C.MP.status === 'running') pi++; } }
  if (phase === 'results' && !done){ done = true; const row = s.results.rows.find(r => r.name === 'A');
    console.log('phases:', seen.join(' → ')); console.log('A:', row.status, 'pts', row.pts, row.notes.join(' '), '| B:', s.results.rows.find(r => r.name === 'B').status);
    console.log('level pieces:', s.level.length, '(初期2 + 設置)'); console.log('client errors:', errors.length ? errors.join('\n') : 'none');
    const ok = seen.join() === 'lobby,box,place,count,run,results' && s.level.length === 4 && (row.status === 'finished' || row.status === 'dead') && !errors.length;
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL'); clearInterval(iv); srv.kill(); process.exit(ok ? 0 : 1); }
  try { C.update(t); } catch (e) { errors.push(String(e.stack)); }
}, 16);
setTimeout(() => { console.log('timeout. phases:', seen.join(' → '), 'errors:', errors.join('\n')); srv.kill(); process.exit(1); }, 15000);
