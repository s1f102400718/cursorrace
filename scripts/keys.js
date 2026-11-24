// 開発用: 指定した日付のデイリーの識別子（版＋コースのハッシュ）を出す（node scripts/keys.js 2026-11-23 2026-11-24）
// 生成に手を入れたとき、既に遊ばれた日のコースが変わっていないことを確かめるのに使う。
const path = require('path');
const { load } = require(path.join(__dirname, '..', 'harness.js'));
const { m } = load(['buildDaily', 'roomLabel']);
for (const d of process.argv.slice(2)){ const c = m.buildDaily(d); console.log(d, c.key, c.rooms.map(r => m.roomLabel(r).replace(/ /g, '')).join('>')); }
