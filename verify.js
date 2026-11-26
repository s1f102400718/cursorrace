'use strict';
// 走りの検証（サーバー用）。送られてきた記録（タイムとゴースト）が「そのコースを実際に走ったもの」らしいかを確かめる。
//   const { courseFor, verifyRun } = require('./verify.js');
//   const c = courseFor(key);                 // 知らないコースなら null
//   const v = verifyRun(c, g, t, d);          // { ok, why } または { ok: true, sus, hold }
//
// できること・できないこと:
//   ゴーストは 30Hz・位置は補間済みなので、1コマ単位の当たり判定までは再現できない。だから速い人を誤って落とさないよう、
//   落とすのは「人の手ではあり得ない」ものだけ: 形が合わない／スタートしていない／出口に触れずに次の部屋へ進んだ／ゴールに触れていない／
//   パッドでない場所で復帰した／瞬間移動／速すぎる／BOT のタイムの 1/6 より速い／長い壁の通り抜け。
//   動く障害物へのめり込みは数える（sus）。多すぎる記録は hold（確認待ち）にして、管理者が通すまでランキングに出さない。
//   当たり判定を切って上手に走った記録や、時間を遅くして走った記録までは見抜けない。最後は管理者が消す（/api/admin）。
//   検証そのものを攻撃の道具にされないよう、道のりを測る回数と1件にかける時間に上限があり、超えたら落とす。
const { load } = require('./harness.js'); // index.html のゲーム本体を node に読み込む（コース・生成・当たり判定を1か所に保つため）
const G = load(['T', 'COURSES', 'DAILY', 'boardKey', 'buildDaily', 'decodeGhost', 'encodeGhost', 'prims', 'hit', 'GH_MAX', 'solveRoom'], { wall: Date.now() }).m;

const V = {
  JUMP: 1000,        // 1サンプル(33ms)で動ける距離の上限(px)。約 30000px/s。部屋の幅が 1280
  WINDOW: 6,         // この数のサンプル（0.2 秒）で…
  WINDOW_LEN: 2800,  // …動ける道のりの上限(px)。約 14000px/s を 0.2 秒続ける速さ
  SECOND: 30,        // 1 秒で…
  SECOND_LEN: 7000,  // …動ける道のりの上限(px)。部屋の幅の 5 倍半
  PAD_NEAR: 300,     // 出口・ゴール・復帰のパッドに「触れた」とみなす余裕(px)。触れた瞬間の前後 0.07 秒ぶんの動き
  PAR_DIV: 6,        // BOT（500px/s で最短の道を行く）のタイムの 1/6 より速い記録は落とす
  CELL: 16,          // 壁をよける道のりを測る格子
  SNAP: 160,         // 補間で壁の中に入った点を、ここまでの距離で外へ寄せる
  DETOUR_HARD: 600,  // 壁をまたいだ1サンプルの「壁をよけた道のり」がこれを超えたら通り抜け（33ms で折り返せる距離ではない）
  DETOUR_SOFT: 300,  // よけた道のりが直線より これだけ長いと「怪しい」1回。3回で通り抜け扱い
  SOFT_MAX: 3,
  DETOUR_BUDGET: 150,// 1つの記録で道のりを測る回数の上限。超えたら落とす（角を削る動きは、速い走りでも数十回）
  TIME_MS: 300,      // 1件の検証にかける時間の上限。超えたら落とす（ふつうの記録は 30ms かからない）
  HAZ_DEEP: 10,      // 動く障害物に これだけ深くめり込んだ点を数える
  HAZ_SAMPLES: 1500, // めり込みを調べる点の数の上限
  HOLD_MIN: 3,       // めり込みがこの数以上で、かつ…
  HOLD_RATE: 0.03,   // …調べた点のこの割合以上なら、確認待ちにする。
                     // 測った分布（固定3コース＋デイリー30日ぶん）: 障害物どおりに走った BOT は全部 0 個。同じ道を時刻だけ速めて障害物を無視した走りは
                     // 中央値で 1〜4 個・1.5% ほど。この条件で確認待ちになるのは、そのうち 2〜4 割。残りは sus の数字を管理者が見て判断する
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
// BOT のタイム(ms)。デイリーは生成のときに出ている。固定コースは最初に聞かれたときに解く。解けなければ null（下限なし）
const PARS = new WeakMap();
function parMs(course){
  if (course.par > 0) return course.par * 1000;
  if (PARS.has(course)) return PARS.get(course);
  let t = 0, pos = course.start, ok = true;
  try { for (const rm of course.rooms){ const s = G.solveRoom(rm, pos, rm.exit, t, true, 40); if (!s.ok){ ok = false; break; } t += s.time; pos = s.path[s.path.length - 1]; } } catch (e) { ok = false; }
  const v = ok && t > 0 ? t * 1000 : null; PARS.set(course, v); return v;
}

// ---- 壁をよけた道のり（格子の上の A*）。部屋ごとに作業用の配列を1組だけ持ち、呼ぶたびに作り直さない ----
const WALLS = new WeakMap();
function wallInfo(room){
  let w = WALLS.get(room); if (w) return w;
  const rects = room.pieces.filter(p => p.t === 'wall' || p.t === 'ghostwall').map(p => ({ k: 'rect', x: p.x, y: p.y, w: p.w, h: p.h }));
  const nx = Math.ceil(G.T.W / V.CELL), ny = Math.ceil(G.T.H / V.CELL), n = nx * ny, blocked = new Uint8Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++){ const x = i * V.CELL + V.CELL / 2, y = j * V.CELL + V.CELL / 2; if (rects.some(r => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h)) blocked[j * nx + i] = 1; }
  w = { rects, nx, ny, blocked, g: new Float32Array(n), seen: new Uint32Array(n), gen: 0, hk: new Float32Array(n * 8 + 8), hv: new Int32Array(n * 8 + 8) };
  WALLS.set(room, w); return w;
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
  const { nx, ny, blocked, g, seen, hk, hv } = w, gen = ++w.gen, ei = e % nx, ej = (e - ei) / nx, C = V.CELL, D = C * Math.SQRT2;
  const h = (i, j) => { const dx = Math.abs(i - ei), dy = Math.abs(j - ej); return C * Math.max(dx, dy) + (D - C) * Math.min(dx, dy); }; // ゴールまでの見積り（斜め移動つきの格子の距離）
  let n = 0;
  const push = (k, v) => { let i = n++; while (i > 0){ const p = i - 1 >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
  const pop = () => { const top = hv[0], k = hk[--n], v = hv[n]; let i = 0; for (;;){ let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && hk[c + 1] < hk[c]) c++; if (hk[c] >= k) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = k; hv[i] = v; return top; };
  seen[s] = gen; g[s] = 0; push(h(s % nx, (s - s % nx) / nx), s);
  while (n > 0){
    const f = hk[0], c = pop(), ci = c % nx, cj = (c - ci) / nx, gc = g[c];
    if (f > cap) return Infinity; if (c === e) return gc;
    if (f > gc + h(ci, cj) + 0.01) continue; // 古い入れ直し
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++){
      if (!di && !dj) continue; const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue; const q = j * nx + i; if (blocked[q]) continue;
      if (di && dj && (blocked[cj * nx + i] || blocked[j * nx + ci])) continue; // 角を斜めにすり抜けない
      const nd = gc + (di && dj ? D : C); if (seen[q] === gen && g[q] <= nd) continue;
      if (n >= hk.length - 1) return Infinity; seen[q] = gen; g[q] = nd; push(nd + h(i, j), q);
    }
  }
  return Infinity;
}
function segDist(c, a, b){ const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let u = l2 > 0 ? ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u; return Math.hypot(a.x + dx * u - c.x, a.y + dy * u - c.y); }

// ---- 検証 ----
function verifyRun(course, g, t, d){
  const t0 = Date.now(), late = () => Date.now() - t0 > V.TIME_MS, bad = why => ({ ok: false, why }), s = G.decodeGhost(g); if (!s || !s.length) return bad('ゴーストを読めない');
  const N = s.length / 5, rooms = course.rooms, last = rooms.length - 1, PR = G.T.PAD_R, hz = G.T.GHOST_HZ;
  if (!(t >= 500) || N > G.GH_MAX) return bad('タイムとゴーストの長さが合わない');
  const cut = N === G.GH_MAX && t >= (N - 1) * 1000 / hz - 1500; // 10分で切れた走り（タイムも 10 分以上）。終わりの確認だけ省く
  if (!cut && Math.abs((N - 1) * 1000 / hz - t) >= 1500) return bad('タイムとゴーストの長さが合わない');
  const par = parMs(course); if (par && t < par / V.PAR_DIV) return bad('速すぎる（BOT の 1/' + V.PAR_DIV + ' 未満）');
  const P = i => ({ x: s[i * 5 + 2], y: s[i * 5 + 3] }), roomAt = i => s[i * 5 + 1], alive = i => s[i * 5 + 4] === 1, dd = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const touched = (pad, q, p, r) => Math.min(dd(q, pad), dd(p, pad), segDist(pad, q, p)) <= r + V.PAD_NEAR; // q → p の間にパッドに触れたとみなせるか
  // 1) スタートパッドから始まる
  if (!alive(0) || roomAt(0) !== 0 || dd(P(0), course.start) > PR + 6) return bad('スタートパッドから始まっていない');
  // 2) 部屋の並び・出口・復帰・壁・速さ
  let deaths = 0, soft = 0, budget = V.DETOUR_BUDGET, sumA = 0, sumB = 0; const lens = new Float32Array(N);
  for (let i = 1; i < N; i++){
    if ((i & 63) === 0 && late()) return bad('確かめるのに時間がかかりすぎる');
    const r = roomAt(i), p = P(i), pr = roomAt(i - 1), q = P(i - 1), step = dd(p, q); if (r > last) return bad('部屋の数が合わない');
    if (r !== pr){ // 次の部屋へ進んだ瞬間: 生きていて、さっきの部屋の出口に触れている
      if (r !== pr + 1 || !alive(i)) return bad('部屋の進み方がおかしい');
      if (!touched(rooms[pr].exit, q, p, PR)) return bad('出口を通っていない');
      if (step > V.JUMP) return bad('瞬間移動');
      lens[i] = step;
    } else {
      if (alive(i - 1) && !alive(i)) deaths++;
      if (alive(i) && (p.x < 0 || p.y < 0 || p.x > G.T.W || p.y > G.T.H)) return bad('部屋の外にいる');
      if (alive(i) && !alive(i - 1)){ // 復帰した瞬間: その部屋の入口かチェックポイントのパッドに触れている（やられた1点で好きな場所へ飛べないように）
        const pads = [r === 0 ? course.start : rooms[r - 1].exit, ...rooms[r].cps];
        if (!pads.some(c => touched(c, q, p, PR * 0.8))) return bad('パッドでない場所で復帰した');
      }
      if (alive(i) && alive(i - 1)){
        lens[i] = step; // やられて戻る間の動きは数えない（判定のない幽霊なので、壁も通ってよい）
        if (step > V.JUMP) return bad('瞬間移動');
        // 壁の通り抜け: 直線が壁をまたいでいたら、壁をよけた道のりを測る
        const w = wallInfo(rooms[r]);
        if (step > 1 && w.rects.some(rc => G.hit(rc, q.x, q.y, p.x, p.y, -2))){
          if (--budget < 0) return bad('壁をまたぐ動きが多すぎる');
          const det = detour(w, q, p, V.DETOUR_HARD + 40);
          if (det > V.DETOUR_HARD) return bad('壁の通り抜け');
          if (det - step > V.DETOUR_SOFT && ++soft >= V.SOFT_MAX) return bad('壁の通り抜け（くり返し）');
        }
      }
    }
    sumA += lens[i]; if (i > V.WINDOW) sumA -= lens[i - V.WINDOW]; if (sumA > V.WINDOW_LEN) return bad('速すぎる');
    sumB += lens[i]; if (i > V.SECOND) sumB -= lens[i - V.SECOND]; if (sumB > V.SECOND_LEN) return bad('速すぎる');
  }
  if (!cut){
    if (roomAt(N - 1) !== last || !alive(N - 1)) return bad('ゴールしていない');
    if (dd(P(N - 1), rooms[last].exit) > PR + V.PAD_NEAR) return bad('ゴールに触れていない');
    if (!(d >= deaths && d <= deaths + 3)) return bad('死亡数が合わない');
  }
  // 3) 動く障害物へのめり込み。その時刻と前後 40ms の3つとも深く入っている点を数える
  let deepN = 0, checked = 0; const stride = Math.max(1, Math.ceil(N / V.HAZ_SAMPLES)), pure = rooms.map(rm => ({ pieces: rm.pieces.filter(p => p.t !== 'wall' && p.t !== 'ghostwall' && !V.STATEFUL.has(p.t)) }));
  const deep = (rm, tm, p) => G.prims(rm, tm).some(pr => G.hit(pr, p.x, p.y, p.x, p.y, -V.HAZ_DEEP));
  for (let i = stride, k = 0; i < N; i += stride, k++){
    if ((k & 31) === 0 && late()) return bad('確かめるのに時間がかかりすぎる');
    if (!alive(i)) continue; checked++; const rm = pure[roomAt(i)]; if (!rm.pieces.length) continue; const p = P(i), tm = s[i * 5] / 1000;
    if (deep(rm, tm, p) && deep(rm, Math.max(0, tm - 0.04), p) && deep(rm, tm + 0.04, p)) deepN++;
  }
  return { ok: true, sus: soft + deepN, hold: deepN >= V.HOLD_MIN && deepN >= checked * V.HOLD_RATE, deaths, samples: N };
}

module.exports = { courseFor, dailyFor, verifyRun, parMs, V, G };
