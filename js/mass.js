// 質量（Mass）と重み付け — 過去設計の「ワタアメ宇宙の物理法則」の簡易移植
//
// Mass = ポスト自身の存在強度。方向を持たない。
//   - セルフ引用（接ぎ木）が最大要因（イト太さに相当）
//   - セルフ再掲（再芽）が次点（イト本数に相当）
//   - 本文の長さがわずかに寄与（コメント量に相当)
//
// Weight = 方向のある力。電光掲示板での浮上しやすさを決める。
//   Weight = Mass × 節目重力（アニバーサリーボーナス）

export function massOf(post) {
  let mass = 1;
  mass += (post.quoteCount || 0) * 2.0;
  mass += (post.repostCount || 0) * 1.2;
  mass += Math.min((post.text || "").length / 140, 2) * 0.3;
  if (post.aiReply) mass += 0.5;
  return mass;
}

// 節目重力: 投稿からの経過日数が「時間軸の節目」に近いほど強く引かれる
const MILESTONES = [
  { days: 7, tolerance: 1.5, gravity: 3.0, label: "1週間前" },
  { days: 30, tolerance: 3, gravity: 3.5, label: "1ヶ月前" },
  { days: 90, tolerance: 5, gravity: 2.0, label: "3ヶ月前" },
  { days: 365, tolerance: 7, gravity: 5.0, label: "1年前" },
  { days: 365 * 5, tolerance: 14, gravity: 6.0, label: "5年前" },
  { days: 365 * 10, tolerance: 21, gravity: 8.0, label: "10年前" },
];

export function ageInDays(post, now = Date.now()) {
  return (now - new Date(post.createdAt).getTime()) / 86400000;
}

export function milestoneBonus(post, now = Date.now()) {
  const age = ageInDays(post, now);
  let bonus = 1;
  let label = null;
  for (const m of MILESTONES) {
    if (Math.abs(age - m.days) <= m.tolerance) {
      if (m.gravity > bonus) {
        bonus = m.gravity;
        label = m.label;
      }
    }
  }
  return { bonus, label };
}

export function weightOf(post, now = Date.now()) {
  return massOf(post) * milestoneBonus(post, now).bonus;
}

// 電光掲示板用: 重み付き非復元サンプリング
// 3日以上前のポストの中から、Weightに比例した確率でn件選ぶ
export function pickForTicker(posts, n = 12, now = Date.now()) {
  const pool = posts
    .filter((p) => ageInDays(p, now) >= 3 && p.text)
    .map((p) => ({ post: p, w: weightOf(p, now) }));

  const picked = [];
  while (picked.length < n && pool.length > 0) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { idx = i; break; }
    }
    picked.push(pool[idx].post);
    pool.splice(idx, 1);
  }
  return picked;
}
