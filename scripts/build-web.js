// 公開用のファイルをそろえる（node scripts/build-web.js [公開先のURL]）。例: node scripts/build-web.js https://example.com/cursorrun
//   dist/web/     置くだけで動く版（GitHub Pages・Cloudflare Pages・Netlify など）。ランキングはその端末だけ、ONLINE は使えない
//   dist/server/  サーバーつきの版（共有ランキングと ONLINE）。Node.js 18 以上の動く場所に置いて  npm ci --omit=dev && node server.js
// 公開先のURLを渡すと、SNS で共有したときの画像（og:image）を絶対URLにする。多くの SNS は相対URLの画像を読まない。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), dist = path.join(root, 'dist'), site = (process.argv[2] || process.env.SITE_URL || '').replace(/\/+$/, '');
if (site && !/^https?:\/\/[^\s"'<>]+$/.test(site)){ console.error('公開先のURLは http(s):// で始めてください: ' + site); process.exit(1); }
if (!fs.existsSync(path.join(root, 'og.png'))){ console.error('og.png がありません。先に node scripts/release-shots.js で作ってください'); process.exit(1); }
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!html.includes('<meta property="og:image" content="og.png">')) throw new Error('index.html に og:image の行がありません');
if (site) html = html.replace('<meta property="og:image" content="og.png">', `<meta property="og:image" content="${site}/og.png">\n<meta property="og:url" content="${site}/">`);
const put = (dir, name, data) => { fs.mkdirSync(path.join(dist, dir), { recursive: true }); fs.writeFileSync(path.join(dist, dir, name), data); };
for (const d of ['web', 'server']) fs.rmSync(path.join(dist, d), { recursive: true, force: true });
// 置くだけの版
put('web', 'index.html', html); put('web', 'og.png', fs.readFileSync(path.join(root, 'og.png'))); put('web', '.nojekyll', '');
// サーバーつきの版: 動かすのに要るファイルだけ（設計書・テスト・開発用の道具は入れない）
put('server', 'index.html', html); put('server', 'og.png', fs.readFileSync(path.join(root, 'og.png')));
for (const f of ['server.js', 'verify.js', 'harness.js', 'package-lock.json', 'Dockerfile', '.dockerignore']) put('server', f, fs.readFileSync(path.join(root, f)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
put('server', 'package.json', JSON.stringify({ name: pkg.name, private: true, version: pkg.version, engines: pkg.engines, scripts: { start: 'node server.js' }, dependencies: pkg.dependencies }, null, 2) + '\n');
const kb = f => Math.round(fs.statSync(f).size / 1024) + 'KB';
console.log(`dist/web     index.html ${kb(path.join(dist, 'web', 'index.html'))} · og.png ${kb(path.join(dist, 'web', 'og.png'))}`);
console.log(`dist/server  ${fs.readdirSync(path.join(dist, 'server')).join(' ')}`);
console.log(site ? `共有用の画像: ${site}/og.png` : '公開先のURLが未指定: 共有用の画像は相対URLのまま（SNS によっては出ません）。決まったら URL を付けて作り直してください');
