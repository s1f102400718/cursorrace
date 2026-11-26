// マルチのフェーズ進行と採点の自動テスト: FAST=1 でサーバーを起動し、偽クライアント2人で1ラウンド回す
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 8123;
const srv = spawn(process.execPath, [__dirname + '/server.js'], { env: { ...process.env, FAST: '1', PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
const log = [];
function client(name){
  const ws = new WebSocket(`ws://localhost:${PORT}`); const c = { name, ws, id: null, snap: null, placed: false, picked: false, acted: false };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: 'test', name })));
  ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'hello') c.id = m.id; if (m.t === 'state'){ c.snap = m; onState(c, m); } if (m.t === 'reject') log.push(name + ' reject'); });
  return c;
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const phases = [];
function onState(c, s){
  if (c.name === 'A' && (!phases.length || phases[phases.length - 1] !== s.phase)) phases.push(s.phase);
  const me = s.players.find(p => p.id === c.id); if (!me) return;
  if (s.phase === 'lobby' && !me.ready && !c.readied && s.players.length >= 2){ c.readied = true; send(c, { t: 'ready' }); }
  if (s.phase === 'box' && me.pick === null && !c.picked){ c.picked = true; const free = s.box.map((b, k) => b.takenBy === null ? k : -1).filter(k => k >= 0); send(c, { t: 'pick', i: c.name === 'A' ? free[0] : free[free.length - 1] }); } // 2人が同じ箱を取り合わないよう、A は先頭・B は末尾から取る
  if (s.phase === 'place' && me.pick !== null && !me.placed && !c.placed){ c.placed = true;
    if (c.name === 'A') send(c, { t: 'place', x: 90, y: 360 }); // スタートパッドの上 → 拒否されるはず
    setTimeout(() => send(c, { t: 'place', x: 640, y: 260, w: 200, h: 160 }), 50); } // どの型でも置ける場所（横断レーザーがパッドを貫かず、背の高い型も部屋に収まる）
  if (s.phase === 'run' && me.status === 'waiting' && !c.acted){ c.acted = true; send(c, { t: 'start' });
    setTimeout(() => send(c, c.name === 'A' ? { t: 'finish' } : { t: 'dead', by: A.id }), 100); } // 倒した人として認められるのは、実際にピースを置いている人だけ（A は置いている）
  if (s.phase === 'results' && !c.seenResults){ c.seenResults = true; if (c.name === 'A') log.push('results: ' + JSON.stringify(s.results.rows.map(r => [r.name, r.status, r.pts, r.notes]))); }
}
let A, B;
srv.stdout.on('data', d => { if (String(d).includes('server:') && !A){ A = client('A'); setTimeout(() => { B = client('B'); }, 100); } });
setTimeout(() => {
  console.log('phases:', phases.join(' → '));
  console.log(log.join('\n'));
  const ok = phases.slice(0, 6).join() === 'lobby,box,place,count,run,results' && log.some(l => l.includes('A reject')) && !log.some(l => l.includes('B reject')) && log.some(l => l.includes('"ゴール +2"') && l.includes('"Bを倒した +1"'));
  console.log(ok ? 'E2E OK' : 'E2E FAIL');
  srv.kill(); process.exit(ok ? 0 : 1);
}, 6000);
