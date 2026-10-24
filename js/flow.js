// 流れ — 過去の自分をタイムラインに混ぜて流すアルゴリズム（AIは使わない）
//
// 3つの部品だけで組む:
//   1. 節目   : 「1年前の今日」のような暦の一致。時間の偶然なので思考の偏りを作らない
//   2. 流れ   : ほぼ一様ランダム × 忘却。最近流したものほど出にくく、
//               長く流れていないものほど戻ってくる（＝「同じのばっかり」を避ける）
//   3. こだま : 書いた直後に、似たことを書いていた過去の投稿を返す（文字bigramの重なり）
//
// 重要度（引用・再掲の回数など）は一切使わない。よく考えていることばかり流れると
// 思考が重心に吸い寄せられ、過去の自分との予期しない再会が起きにくくなるため。
//
// 「いつ流したか」の記録は端末ローカル（cns.surface.v1）に持ち、投稿データには混ぜない。
// 投稿に書き込むとクラウド同期で端末間の衝突が起きるうえ、流れ方は端末ごとで構わない。

const SURFACE_KEY = "cns.surface.v1"; // { [postId]: { last: epochMs, n: number, muted?: true } }
const DAILY_KEY = "cns.flow.daily.v1"; // { day: "YYYY-MM-DD", count: number }

const DAY_MS = 86400000;
const MIN_AGE_DAYS = 1;        // 1日以上前の投稿だけを「過去の自分」として流す
const FORGET_TAU_DAYS = 14;    // 忘却の時定数。流してから約2週間で出やすさが6割強まで戻る
const MIN_WEIGHT = 0.02;       // 流した直後でもゼロにはしない（小さいプールで詰まらないように）
const ECHO_THRESHOLD = 0.12;   // こだまとして返す類似度の下限
export const DAILY_SOFT_LIMIT = 45; // 1日にこれだけ流れたら「今日はここまで」の合図を出す

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量超過などは無視 */ }
}

let surface = load(SURFACE_KEY, {});

export function ageInDays(post, now = Date.now()) {
  return (now - new Date(post.createdAt).getTime()) / DAY_MS;
}

// ---- 流した記録 / もう流さない ----

export function markSurfaced(ids, now = Date.now()) {
  for (const id of ids) {
    const s = surface[id] || { n: 0 };
    surface[id] = { ...s, last: now, n: (s.n || 0) + 1 };
  }
  save(SURFACE_KEY, surface);
}

export function mute(id) {
  surface[id] = { ...(surface[id] || { n: 0 }), muted: true };
  save(SURFACE_KEY, surface);
}

export function mutedCount() {
  return Object.values(surface).filter((s) => s.muted).length;
}

export function unmuteAll() {
  for (const s of Object.values(surface)) delete s.muted;
  save(SURFACE_KEY, surface);
}

export function resetSurface() {
  surface = {};
  try {
    localStorage.removeItem(SURFACE_KEY);
    localStorage.removeItem(DAILY_KEY);
  } catch { /* 無視 */ }
}

// ---- 1日の流量（止めどきの合図に使う） ----

function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dailyCount(now = Date.now()) {
  const d = load(DAILY_KEY, null);
  return d && d.day === todayKey(now) ? d.count : 0;
}

function addDailyCount(n, now = Date.now()) {
  save(DAILY_KEY, { day: todayKey(now), count: dailyCount(now) + n });
}

// ---- 流せる投稿 ----

// 再掲（中身なし）は流さない。元の投稿の方が流れればよい。
function isFlowable(post, now) {
  if (!post.text || post.type === "repost") return false;
  if (surface[post.id]?.muted) return false;
  return ageInDays(post, now) >= MIN_AGE_DAYS;
}

// ---- 1. 節目（暦の一致） ----

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 「◯年前の今日」「◯ヶ月前の今日」「1週間前の今日」なら、そのラベルを返す。
export function anniversaryLabel(post, now = Date.now()) {
  const d = new Date(post.createdAt);
  const t = new Date(now);
  const days = Math.round((startOfDay(t) - startOfDay(d)) / DAY_MS);
  if (days < 7) return null;
  if (d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) {
    return `${t.getFullYear() - d.getFullYear()}年前の今日`;
  }
  const months = (t.getFullYear() - d.getFullYear()) * 12 + (t.getMonth() - d.getMonth());
  if (d.getDate() === t.getDate() && [1, 3, 6].includes(months)) return `${months}ヶ月前の今日`;
  if (days === 7) return "1週間前の今日";
  return null;
}

// 今日が節目にあたる投稿。古いもの（＝遠い再会）を優先して max 件。
export function pickAnniversaries(posts, max = 3, now = Date.now()) {
  return posts
    .filter((p) => isFlowable(p, now) && anniversaryLabel(p, now))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, max);
}

// ---- 2. 流れ（ほぼ一様ランダム × 忘却） ----

// 最後に流してからの日数で出やすさが回復する。一度も流していなければ投稿日から数える
// （＝書いたきり忘れていたものほど戻ってきやすい）。
function forgetWeight(post, now) {
  const last = surface[post.id]?.last ?? new Date(post.createdAt).getTime();
  const days = Math.max(0, (now - last) / DAY_MS);
  return Math.max(MIN_WEIGHT, 1 - Math.exp(-days / FORGET_TAU_DAYS));
}

// 重み付きで n 件を非復元抽出する。exclude に入っているidは選ばない。
// 同じ連（スレッド）からは1件だけにして、1回の流れに同じ一息が固まらないようにする。
export function pickFlow(posts, n, { exclude = new Set(), now = Date.now() } = {}) {
  const pool = posts
    .filter((p) => isFlowable(p, now) && !exclude.has(p.id))
    .map((p) => ({ post: p, w: forgetWeight(p, now) }));

  const picked = [];
  const usedThreads = new Set();
  while (picked.length < n && pool.length > 0) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { idx = i; break; }
    }
    const [{ post }] = pool.splice(idx, 1);
    if (post.threadId && usedThreads.has(post.threadId)) continue;
    if (post.threadId) usedThreads.add(post.threadId);
    picked.push(post);
  }

  markSurfaced(picked.map((p) => p.id), now);
  addDailyCount(picked.length, now);
  return picked;
}

// ---- 3. こだま（似たことを書いていた過去の自分） ----

// 日本語は単語に割らずに文字bigramで比べる。URL・記号・空白・タグ記号は落とす。
function bigrams(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

// post に似た過去の投稿を最大 k 件。同じ連・引用元・1日以内の投稿は除く。
export function findEchoes(post, posts, k = 3, now = Date.now()) {
  const target = bigrams(post.text);
  if (target.size < 2) return [];
  const tags = new Set(post.tags || []);

  const scored = [];
  for (const p of posts) {
    if (p.id === post.id || p.id === post.refId) continue;
    if (post.threadId && p.threadId === post.threadId) continue;
    if (!isFlowable(p, now)) continue;
    const sharedTag = (p.tags || []).some((t) => tags.has(t));
    const score = jaccard(target, bigrams(p.text)) + (sharedTag ? 0.15 : 0);
    if (score >= ECHO_THRESHOLD) scored.push({ post: p, score });
  }
  const echoes = scored.sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.post);
  markSurfaced(echoes.map((p) => p.id), now);
  return echoes;
}
