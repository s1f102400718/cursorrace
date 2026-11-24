// テスト用: index.html の <script> を node 上で読み込み、指定した名前を取り出す。
// DOM・canvas・localStorage・時刻は代用品を「引数として」渡すので、同じプロセスで何人ぶんでも独立に動かせる。
//   const { m, clock, store, errors } = load(['update', 'state', ...], { store, wall, location, fetch, claude })
//   clock.t を進めて m.update(clock.t) を呼ぶと1フレーム進む。ゲームが見る現在時刻は wall + clock.t。
const fs = require('fs');
function load(names, opts = {}){
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const grad = { addColorStop(){} };
  const ctxStub = new Proxy({ roundRect(){} }, { get: (t, k) => k in t ? t[k] : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => grad : k === 'measureText' ? () => ({ width: 0 }) : () => {} });
  const el = () => ({ textContent: '', innerHTML: '', value: '', hidden: false, style: {}, addEventListener(){}, focus(){}, blur(){}, select(){}, getContext: () => ctxStub, width: 0, height: 0 });
  const store = opts.store || new Map(), errors = [];
  const clock = { t: 0, wall: opts.wall || Date.UTC(2026, 10, 23, 3, 0, 0) };
  const env = {
    document: { getElementById: el, createElement: el, documentElement: {}, addEventListener(){}, hidden: false },
    window: { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, addEventListener(){}, claude: opts.claude }, // claude: 公開アーティファクトの実行環境の代用品
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); }, key: i => [...store.keys()][i], get length(){ return store.size; } },
    performance: { now: () => clock.t },
    requestAnimationFrame: () => {},
    location: opts.location || { protocol: 'file:', host: '', search: '', origin: 'null', pathname: '/index.html' },
    fetch: opts.fetch,
    navigator: undefined,
    Date: class extends Date { static now(){ return clock.wall + clock.t; } }, // 「今日」を固定する
    console: { ...console, error: e => errors.push(String(e && e.stack || e)) },
  };
  const src = js.replace(/requestAnimationFrame\(loop\);\s*$/, '') + ';return {' + names.map(n => `get ${n}(){ return ${n}; }`).join(',') + '};';
  const m = new Function(...Object.keys(env), src)(...Object.values(env));
  return { m, clock, store, errors };
}
// BOT（ソルバー）の経路を部屋の並びぶん求める。解けない部屋があれば { fail: 部屋番号 }。m には solveRoom が要る
function botPath(m, rooms, start){
  const bot = []; let t = 0, pos = start;
  for (let i = 0; i < rooms.length; i++){
    const s = m.solveRoom(rooms[i], pos, rooms[i].exit, t, true, 40); if (!s.ok) return { fail: i };
    for (const p of s.path) bot.push(Math.round(p.t * 1000), i, p.x, p.y, 1);
    t += s.time; pos = s.path[s.path.length - 1];
  }
  return { bot, time: t };
}
// コースを開いた直後（state が 'title'）から、BOT の経路を本物のゲームループに流す。m には samples, update, state が要る
function runBot(m, clock, bot){
  m.samples.push({ x: bot[2], y: bot[3] }); clock.t += 16; m.update(clock.t);
  for (let i = 0; i < 400 && m.state === 'count'; i++){ clock.t += 16; m.update(clock.t); }
  if (m.state !== 'race') return false;
  const t0 = clock.t; let last = -1;
  for (let i = 0; i < bot.length && m.state === 'race'; i += 5){ if (bot[i] === last) continue; last = bot[i]; clock.t = t0 + bot[i]; m.samples.push({ x: bot[i + 2], y: bot[i + 3] }); m.update(clock.t); }
  return m.state === 'done';
}
// パッドの中心と縁16点（半径1に正規化）。パッド上のカーソルが当たらないことを確かめるのに使う
const RIM = [[0, 0], ...Array.from({ length: 16 }, (_, i) => [Math.cos(i / 16 * Math.PI * 2), Math.sin(i / 16 * Math.PI * 2)])];
module.exports = { load, botPath, runBot, RIM };
