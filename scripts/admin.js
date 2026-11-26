// ランキングの管理（サーバーを ADMIN_TOKEN つきで起動しているときだけ使える）
//   set ADMIN_TOKEN=<合言葉>            （PowerShell なら $env:ADMIN_TOKEN = '<合言葉>'）
//   node scripts/admin.js <サーバーのURL> boards                表の一覧（新しい順）
//   node scripts/admin.js <サーバーのURL> board <コースの識別子>  全行。sus = 検証で数えた怪しい点の数（多いほど疑わしい）
//   node scripts/admin.js <サーバーのURL> remove <識別子> <pid>   1行とそのゴーストを消す
//   node scripts/admin.js <サーバーのURL> approve <識別子> <pid>  確認待ち（hold）の行を通して、ランキングに出す
const [base, cmd, key, pid] = process.argv.slice(2), token = process.env.ADMIN_TOKEN;
if (!base || !cmd || !token){ console.log('使い方: ADMIN_TOKEN を設定して  node scripts/admin.js <URL> boards | board <key> | remove <key> <pid> | approve <key> <pid>'); process.exit(1); }
const url = p => base.replace(/\/+$/, '') + '/api/admin/' + p, headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
(async () => {
  if (cmd === 'boards'){ const j = await (await fetch(url('boards'), { headers })).json(); if (!j.boards) throw new Error(JSON.stringify(j)); for (const b of j.boards) console.log(String(b.rows).padStart(4), b.key); }
  else if (cmd === 'board' && key){ const j = await (await fetch(url('board/' + encodeURIComponent(key)), { headers })).json(); if (!j.rows) throw new Error(JSON.stringify(j));
    j.rows.forEach((r, i) => console.log(`${String(i + 1).padStart(3)}  ${(r.t / 1000).toFixed(2).padStart(8)}s  deaths ${String(r.d).padStart(3)}  sus ${String(r.sus).padStart(3)} ${r.hold ? '確認待ち' : '        '}  ${r.pid}  ${r.name}  ${new Date(r.ts).toISOString()}`)); }
  else if (cmd === 'remove' && key && pid){ const r = await fetch(url('remove'), { method: 'POST', headers, body: JSON.stringify({ key, pid }) }); console.log(r.status === 200 ? '消しました' : '消せませんでした（' + r.status + '）'); }
  else if (cmd === 'approve' && key && pid){ const r = await fetch(url('approve'), { method: 'POST', headers, body: JSON.stringify({ key, pid }) }); console.log(r.status === 200 ? '通しました' : '通せませんでした（' + r.status + '）'); }
  else console.log('知らない命令: ' + cmd);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
