// 公開アーティファクト用のファイルを作る（node scripts/build-artifact.js → dist/artifact.html）。
// 公開時に <!doctype>・<html>・<head>・<body> は自動で付くので、index.html からその外側だけを外す。
// 中身（<title>・フォント・<style>・本体・<script>）は index.html と同じ。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>')).replace(/^\s*<meta[^>]*>\s*$/gm, '').trim();
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>')).trim();
if (!/^<title>/.test(head)) throw new Error('<title> が先頭にありません');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), head + '\n' + body + '\n');
console.log('dist/artifact.html', Math.round((head.length + body.length) / 1024) + 'KB');
