'use strict';
// 走りの検証（サーバー用）。送られてきた記録（タイムとゴースト）が「そのコースを実際に走ったもの」らしいかを確かめる。
//   const { courseFor, verifyRun } = require('./verify.js');
//   const c = courseFor(key);                 // 知らないコースなら null
//   const v = verifyRun(c, g, t, d);          // { ok, why, sus }
//
// できること・できないこと:
//   ゴーストは 30Hz・位置は補間済みなので、1コマ単位の当たり判定までは再現できない。だから速い人を誤って落とさないよう、
//   「人の手ではあり得ない」ものだけを落とす: 形が合わない／スタートしていない／部屋を飛ばした／ゴールしていない／
//   瞬間移動／長い壁の通り抜け。動く障害物へのめり込みは数えて記録に残すだけ（sus）。怪しい記録を消すのは管理者（/api/admin）。
//   当たり判定を切って上手に走った記録や、時間を遅くして走った記録までは見抜けない。
const { load } = require('./harness.js'); // index.html のゲーム本体を node に読み込む（コース・生成・当たり判定を1か所に保つため）
const G = load(['T', 'COURSES', 'DAILY', 'boardKey', 'buildDaily', 'decodeGhost', 'encodeGhost', 'prims', 'hit', 'GH_MAX'], { wall: Date.now() }).m;

const V = {
  JUMP: 1000,        // 1サンプル(33ms)で動ける距離の上限(px)。約 30000px/s。画面の幅が 1280
  WINDOW: 6,         // この数のサンプル（200ms）で…
  WINDOW_LEN: 2800,  // …動ける道のりの上限(px)。約 14000px/s を 0.2 秒続ける速さ
  CELL: 16,          // 壁をよける道のりを測る格子
  SNAP: 160,         // 補間で壁の中に入った点を、ここまでの距離で外へ寄せる
  DETOUR_HARD: 600,  // 壁をまたいだ1サンプルの「壁をよけた道のり」がこれを超えたら通り抜け（33ms で折り返せる距離ではない）
  DETOUR_SOFT: 300,  // よけた道のりが直線より これだけ長いと「怪しい」1回。3回で通り抜け扱い
  SOFT_MAX: 3,
  DETOUR_BUDGET: 400,// 1つの記録で道のりを測る回数の上限（わざと重くする記録への備え）
  HAZ_DEEP: 10,      // 動く障害物に これだけ深くめり込んだ点を数える
  HAZ_SAMPLES: 1500, // めり込みを調べる点の数の上限
  STATEFUL: new Set(['aimed', 'mine', 'chaser', 'shadow', 'speedzone', 'nostop', 'dark', 'fog', 'fakewall']), // 時刻だけでは決まらない／当たらない型は調べない
};

// ---- コース ----
const FIXED = new Map(G.COURSES.map(c => [G.boardKey(c), c]));
const DAILIES = new Map(); // 日付 → コース（新しい順に数個だけ覚える）
function dailyFor(date){
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !(Date.parse(date + 'T00:00:00Z') >= Date.parse(G.DAILY.EPOCH + 'T00:00:00Z'))) return null;
  let c = DAILIES.get(date);
  if (!c){ try { c = G.buildDaily(date); } catch (e) { return null; } DAILIES.set(date, c); while (DAILIES.size > 6) DAILIES.delete(DAILIES.keys().next().value); }
  return c;
}
function courseFor(key){
  if (FIXED.has(key)) return FIXED.get(key);
  const m = /^d-(\d{4}-\d\d-\d\d)-/.exec(String(key)); if (!m) return null;
  const c = dailyFor(m[1]); return c && c.key === key ? c : null; // 版や中身が違うコース（古いページのまま等）は別の識別子になる
}

// ---- 壁をよけた道のり ----
const WALLS = new WeakMap();
function wallInfo(room){
  let w = WALLS.get(room); if (w) return w;
  const rects = room.pieces.filter(p => p.t === 'wall' || p.t === 'ghostwall').map(p => ({ k: 'rect', x: p.x, y: p.y, w: p.w, h: p.h }));
  const nx = Math.ceil(G.T.W / V.CELL), ny = Math.ceil(G.T.H / V.CELL), blocked = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++){ const x = i * V.CELL + V.CELL / 2, y = j * V.CELL + V.CELL / 2; if (rects.some(r => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h)) blocked[j * nx + i] = 1; }
  w = { rects, nx, ny, blocked }; WALLS.set(room, w); return w;
}
function nearestFree(w, p){ // p にいちばん近い空きセル（無ければ -1）
  const ci = Math.max(0, Math.min(w.nx - 1, Math.floor(p.x / V.CELL))), cj = Math.max(0, Math.min(w.ny - 1, Math.floor(p.y / V.CELL)));
  if (!w.blocked[cj * w.nx + ci]) return cj * w.nx + ci;
  let best = -1, bd = Infinity; const R = Math.ceil(V.SNAP / V.CELL);
  for (let j = Math.max(0, cj - R); j <= Math.min(w.ny - 1, cj + R); j++) for (let i = Math.max(0, ci - R); i <= Math.min(w.nx - 1, ci + R); i++){
    if (w.blocked[j * w.nx + i]) continue; const d = Math.hypot(i * V.CELL + V.CELL / 2 - p.x, j * V.CELL + V.CELL / 2 - p.y); if (d < bd){ bd = d; best = j * w.nx + i; } }
  return bd <= V.SNAP ? best : -1;
}
function detour(w, a, b, cap){ // 静止壁をよけて a → b へ行く最短の道のり(px)。cap を超える・道がないなら Infinity
  const s = nearestFree(w, a), e = nearestFree(w, b); if (s < 0 || e < 0) return Infinity;
  if (s === e) return Math.hypot(a.x - b.x, a.y - b.y);
  const { nx, ny, blocked } = w, dist = new Float32Array(nx * ny).fill(Infinity), heap = [[0, s]]; dist[s] = 0;
  const push = it => { heap.push(it); let i = heap.length - 1; while (i > 0){ const p = i - 1 >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length){ heap[0] = last; let i = 0; for (;;){ const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length){
    const [d, c] = pop(); if (d > dist[c]) continue; if (c === e) return d; if (d > cap) return Infinity;
    const ci = c % nx, cj = (c - ci) / nx;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++){
      if (!di && !dj) continue; const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue; const n = j * nx + i; if (blocked[n]) continue;
      if (di && dj && (blocked[cj * nx + i] || blocked[j * nx + ci])) continue; // 角を斜めにすり抜けない
      const nd = d + (di && dj ? V.CELL * Math.SQRT2 : V.CELL); if (nd < dist[n]){ dist[n] = nd; push([nd, n]); }
    }
  }
  return Infinity;
}

// ---- 検証 ----
function verifyRun(course, g, t, d){
  const bad = why => ({ ok: false, why }), s = G.decodeGhost(g); if (!s || !s.length) return bad('ゴーストを読めない');
  const N = s.length / 5, rooms = course.rooms, last = rooms.length - 1, PR = G.T.PAD_R, cut = N >= G.GH_MAX; // 10分で切れた走りは、終わりの確認を省く
  const P = i => ({ x: s[i * 5 + 2], y: s[i * 5 + 3] }), roomAt = i => s[i * 5 + 1], alive = i => s[i * 5 + 4] === 1, dd = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  if (!(t >= 500) || Math.abs((N - 1) * 1000 / G.T.GHOST_HZ - t) >= 1500 && !cut) return bad('タイムとゴーストの長さが合わない');
  // 1) スタートパッドから始まる
  if (!alive(0) || roomAt(0) !== 0 || dd(P(0), course.start) > PR + 6) return bad('スタートパッドから始まっていない');
  // 2) 部屋の並びと終わり
  let deaths = 0, soft = 0, budget = V.DETOUR_BUDGET; const lens = [];
  for (let i = 0; i < N; i++){
    const r = roomAt(i), p = P(i); if (r > last) return bad('部屋の数が合わない');
    if (i === 0){ lens.push(0); continue; }
    const pr = roomAt(i - 1), q = P(i - 1), step = dd(p, q);
    if (r !== pr){ // 次の部屋へ進んだ瞬間: 生きていて、出たのはさっきの部屋の出口の近く
      if (r !== pr + 1 || !alive(i)) return bad('部屋の進み方がおかしい');
      if (dd(p, rooms[pr].exit) > PR + V.JUMP || dd(q, rooms[pr].exit) > PR + V.JUMP) return bad('出口を通っていない');
      lens.push(step); continue;
    }
    if (alive(i - 1) && !alive(i)) deaths++;
    if (alive(i) && (p.x < 0 || p.y < 0 || p.x > G.T.W || p.y > G.T.H)) return bad('部屋の外にいる');
    lens.push(alive(i) && alive(i - 1) ? step : 0); // やられて戻る間の動きは数えない
    if (!(alive(i) && alive(i - 1))) continue;
    // 3) 瞬間移動
    if (step > V.JUMP) return bad('瞬間移動');
    // 4) 壁の通り抜け: 直線が壁をまたいでいたら、壁をよけた道のりを測る
    const w = wallInfo(rooms[r]);
    if (step > 1 && budget > 0 && w.rects.some(rc => G.hit(rc, q.x, q.y, p.x, p.y, -2))){
      budget--; const det = detour(w, q, p, V.DETOUR_HARD + 40);
      if (det > V.DETOUR_HARD) return bad('壁の通り抜け');
      if (det - step > V.DETOUR_SOFT && ++soft >= V.SOFT_MAX) return bad('壁の通り抜け（くり返し）');
    }
  }
  for (let i = 1, sum = 0; i < N; i++){ // 5) 速さ: 続く 0.2 秒ぶんの道のり
    sum += lens[i]; if (i > V.WINDOW) sum -= lens[i - V.WINDOW];
    if (sum > V.WINDOW_LEN) return bad('速すぎる');
  }
  if (!cut){
    if (roomAt(N - 1) !== last || !alive(N - 1)) return bad('ゴールしていない');
    if (dd(P(N - 1), rooms[last].exit) > PR + V.JUMP) return bad('ゴールの近くで終わっていない');
    if (!(d >= deaths && d <= deaths + 3)) return bad('死亡数が合わない');
  }
  // 6) 動く障害物へのめり込み（数えるだけ）。その時刻と前後 40ms の3つとも深く入っている点
  let sus = soft; const stride = Math.max(1, Math.ceil(N / V.HAZ_SAMPLES)), pure = rooms.map(rm => ({ pieces: rm.pieces.filter(p => p.t !== 'wall' && p.t !== 'ghostwall' && !V.STATEFUL.has(p.t)) }));
  const deep = (rm, tm, p) => G.prims(rm, tm).some(pr => G.hit(pr, p.x, p.y, p.x, p.y, -V.HAZ_DEEP));
  for (let i = stride; i < N; i += stride){
    if (!alive(i) || !pure[roomAt(i)].pieces.length) continue; const p = P(i), tm = s[i * 5] / 1000, rm = pure[roomAt(i)];
    if (deep(rm, tm, p) && deep(rm, Math.max(0, tm - 0.04), p) && deep(rm, tm + 0.04, p)) sus++;
  }
  return { ok: true, sus, deaths, samples: N };
}

module.exports = { courseFor, dailyFor, verifyRun, V, G };
