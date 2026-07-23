// 電光掲示板の抽選ロジック — 「忘却 × 偶然」エンジン
//
// 設計転換（v2）: 掲示板は「重要度」で回さない。
//   重要なテーマ（＝繰り返し出る＝重心）を重く扱うと、掲示板は既によく考えてる
//   ことばかりを流し始め、思考が重心に吸い寄せられてひらめきが生まれにくくなる
//   （レコメンドのフィルターバブルと同じ）。掲示板の価値は「過去の自分との予期
//   しない衝突」なので、抽選は基本フラット（ほぼランダム）にする。
//
//   - 接ぎ木・再芽の回数は抽選に効かせない（＝掲示板のために接ぎ木する義務をなくす）
//   - 直近クールダウン: 最近流したものは一定回数ハブる（「同じのばっかり」を殺す本命）
//   - 節目重力だけ薄く残す: 「ちょうど1年前の今日」は時間の偶然でありフィルター
//     バブルを作らないので、軽い味付けとして残す

export function ageInDays(post, now = Date.now()) {
  return (now - new Date(post.createdAt).getTime()) / 86400000;
}

// 節目重力: 投稿からの経過日数が「時間軸の節目」に近いほど強く引かれる。
// 掲示板の抽選では ANNIVERSARY_STRENGTH で薄めて使い、ラベル表示にも使う。
const MILESTONES = [
  { days: 7, tolerance: 1.5, gravity: 3.0, label: "1週間前" },
  { days: 30, tolerance: 3, gravity: 3.5, label: "1ヶ月前" },
  { days: 90, tolerance: 5, gravity: 2.0, label: "3ヶ月前" },
  { days: 365, tolerance: 7, gravity: 5.0, label: "1年前" },
  { days: 365 * 5, tolerance: 14, gravity: 6.0, label: "5年前" },
  { days: 365 * 10, tolerance: 21, gravity: 8.0, label: "10年前" },
];

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

// 節目重力をどれだけ抽選に効かせるか。0で完全フラット、1で従来の強さ。
// 「ほぼランダム＋節目だけ薄く」なので小さめ（10年前で約2倍、1年前で約1.6倍）。
const ANNIVERSARY_STRENGTH = 0.15;

// 直近クールダウン: 最近流したポストidを新しい順に保持し、次の抽選から除外する。
// これが「同じのばっかり流れる」を実際に止めるレバー（重み付けとは独立に効く）。
const COOLDOWN_CAP = 40;
let cooldown = [];

// 電光掲示板用: ほぼ一様ランダム（＋節目だけ薄い重み）で n 件選ぶ。
// 3日以上前のポストが対象。直近で流したものはクールダウンで避ける。
export function pickForTicker(posts, n = 12, now = Date.now()) {
  const pool = posts.filter((p) => ageInDays(p, now) >= 3 && p.text);
  if (pool.length === 0) return [];

  // クールダウン適用: 足りなければ古いものから順に解禁して n 件を確保する
  let blocked = cooldown.slice();
  let eligible = pool.filter((p) => !blocked.includes(p.id));
  while (eligible.length < n && blocked.length > 0) {
    blocked = blocked.slice(0, -1); // 一番古いクールダウンを1つ解禁
    eligible = pool.filter((p) => !blocked.includes(p.id));
  }
  if (eligible.length === 0) eligible = pool.slice();

  const weighted = eligible.map((p) => ({
    post: p,
    w: 1 + (milestoneBonus(p, now).bonus - 1) * ANNIVERSARY_STRENGTH,
  }));

  const picked = [];
  while (picked.length < n && weighted.length > 0) {
    const total = weighted.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < weighted.length; i++) {
      r -= weighted[i].w;
      if (r <= 0) { idx = i; break; }
    }
    picked.push(weighted[idx].post);
    weighted.splice(idx, 1);
  }

  // 流したものをクールダウンへ（新しい順に前へ積む）
  cooldown = [...picked.map((p) => p.id), ...cooldown].slice(0, COOLDOWN_CAP);
  return picked;
}
