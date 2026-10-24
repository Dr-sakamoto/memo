// データ層 — すべてlocalStorageに保存する（Closed Network の核）

const POSTS_KEY = "cns.posts.v1";
const SETTINGS_KEY = "cns.settings.v1";
// 旧版のAIレポート。いまは画面に出さないが、同期・エクスポートではそのまま持ち運ぶ（消さない）。
const REPORTS_KEY = "cns.reports.v1";
const DELETED_KEY = "cns.deleted.v1"; // 削除の記録（クラウド同期で「削除」を伝播させるための墓標）

export const MOODS = [
  { value: 2,  emoji: "😄" },
  { value: 1,  emoji: "🙂" },
  { value: 0,  emoji: "😐" },
  { value: -1, emoji: "😞" },
  { value: -2, emoji: "😢" },
];

const DEFAULT_SETTINGS = {
  threadWindowMin: 5,               // 連（スレッド）: 直前の投稿からこの分数以内なら「同じ一息」として自動で束ねる
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---- 変更通知（クラウド同期のためのフック） ----
// データを書き換えるたびに購読者へ通知する。sync.js が受けて自動プッシュに使う。
const mutationListeners = new Set();

export function onMutation(cb) {
  mutationListeners.add(cb);
  return () => mutationListeners.delete(cb);
}

function notifyMutation() {
  for (const cb of mutationListeners) {
    try { cb(); } catch { /* 購読者の失敗は無視 */ }
  }
}

let posts = load(POSTS_KEY, []);
let reports = load(REPORTS_KEY, []);

// { postIds: { [id]: deletedAtIso }, reportIds: { [id]: deletedAtIso } }
let deletedIds = load(DELETED_KEY, { postIds: {}, reportIds: {} });
if (!deletedIds.postIds) deletedIds.postIds = {};
if (!deletedIds.reportIds) deletedIds.reportIds = {};

let settings = { ...DEFAULT_SETTINGS, ...load(SETTINGS_KEY, {}) };

export function getPosts() {
  return posts;
}

export function getPost(id) {
  return posts.find((p) => p.id === id) || null;
}

export function getSettings() {
  return settings;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function extractTags(text) {
  const tags = new Set();
  for (const m of text.matchAll(/#([^\s#]+)/g)) tags.add(m[1]);
  return [...tags];
}

// type: "post" | "repost" | "quote"
// standalone: true にすると連（スレッド）への自動連結を抑止し、新しい話題として切る
export function addPost({ text, mood, type = "post", refId = null, standalone = false }) {
  const now = new Date();
  const post = {
    id: newId(),
    type,
    text: text || "",
    kind: "雑記",
    mood: mood ?? null,
    tags: extractTags(text || ""),
    refId,
    threadId: null,
    repostCount: 0,
    quoteCount: 0,
    aiReply: null,
    createdAt: now.toISOString(),
  };
  posts.unshift(post);

  // 連（スレッド）: 連続した通常投稿は「同じ一息」として自動で束ねる。
  // 接ぎ木（意味の接続）とは別プリミティブなので、質量は水増ししない。
  if (type === "post" && !standalone) {
    const prev = posts[1]; // unshift直後なので直前の投稿は index 1
    if (prev && prev.type === "post") {
      const gapMin = (now.getTime() - new Date(prev.createdAt).getTime()) / 60000;
      const windowMin = settings.threadWindowMin ?? DEFAULT_SETTINGS.threadWindowMin;
      if (gapMin >= 0 && gapMin <= windowMin) {
        post.threadId = prev.threadId || newId();
        if (!prev.threadId) prev.threadId = post.threadId;
      }
    }
  }

  if (refId) {
    const ref = getPost(refId);
    if (ref) {
      if (type === "repost") ref.repostCount = (ref.repostCount || 0) + 1;
      if (type === "quote") ref.quoteCount = (ref.quoteCount || 0) + 1;
    }
  }
  save(POSTS_KEY, posts);
  notifyMutation();
  return post;
}

// 連（スレッド）の途中で「ここから話題が変わる」と手動で断ち切る。
// postId は継続側（新しい方）の投稿。そこから新しい側と古い側の2つの塊に分割する。
export function breakThreadLink(postId) {
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx === -1) return false;
  const tid = posts[idx].threadId;
  if (!tid || !posts[idx + 1] || posts[idx + 1].threadId !== tid) return false;

  // 同じ threadId の連続範囲を求める（新しい側の始点 s 〜 古い側の終点 e）
  let s = idx;
  while (s - 1 >= 0 && posts[s - 1].threadId === tid) s--;
  let e = idx;
  while (e + 1 < posts.length && posts[e + 1].threadId === tid) e++;

  const newerSeg = posts.slice(s, idx + 1);
  const olderSeg = posts.slice(idx + 1, e + 1);

  const newTid = newerSeg.length > 1 ? newId() : null;
  newerSeg.forEach((p) => { p.threadId = newTid; });
  if (olderSeg.length === 1) olderSeg[0].threadId = null;

  save(POSTS_KEY, posts);
  notifyMutation();
  return true;
}

export function deletePost(id) {
  const post = getPost(id);
  if (!post) return;
  // 参照カウントを戻す
  if (post.refId) {
    const ref = getPost(post.refId);
    if (ref) {
      if (post.type === "repost") ref.repostCount = Math.max(0, ref.repostCount - 1);
      if (post.type === "quote") ref.quoteCount = Math.max(0, ref.quoteCount - 1);
    }
  }
  posts = posts.filter((p) => p.id !== id);
  save(POSTS_KEY, posts);
  deletedIds.postIds[id] = new Date().toISOString();
  save(DELETED_KEY, deletedIds);
  notifyMutation();
}

// ---- エクスポート / インポート ----

export function exportJson() {
  return JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    posts,
    reports,
  }, null, 2);
}

export function importJson(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data.posts)) throw new Error("不正なファイル形式です");
  posts = data.posts;
  reports = Array.isArray(data.reports) ? data.reports : [];
  // 明示的な全置き換えなので、これまでの削除記録は持ち越さない
  deletedIds = { postIds: {}, reportIds: {} };
  save(POSTS_KEY, posts);
  save(REPORTS_KEY, reports);
  save(DELETED_KEY, deletedIds);
  notifyMutation();
}

// クラウド同期がマージ結果を反映するための差し替え。
// リモート由来の適用なので notifyMutation は呼ばない（プッシュのループを避ける）。
export function replaceData({ posts: nextPosts, reports: nextReports, deletedPostIds, deletedReportIds }) {
  if (Array.isArray(nextPosts)) {
    posts = nextPosts;
    save(POSTS_KEY, posts);
  }
  if (Array.isArray(nextReports)) {
    reports = nextReports;
    save(REPORTS_KEY, reports);
  }
  if (deletedPostIds || deletedReportIds) {
    deletedIds = {
      postIds: deletedPostIds || deletedIds.postIds,
      reportIds: deletedReportIds || deletedIds.reportIds,
    };
    save(DELETED_KEY, deletedIds);
  }
}

// 同期対象の生データ（AIキーなどの設定は含めない）。
// deletedPostIds/deletedReportIds は「削除済みid」の墓標で、
// 同期先に残っていても復活させないために使う。
export function snapshot() {
  return {
    posts,
    reports,
    deletedPostIds: { ...deletedIds.postIds },
    deletedReportIds: { ...deletedIds.reportIds },
  };
}

export function wipeAll() {
  posts = [];
  reports = [];
  deletedIds = { postIds: {}, reportIds: {} };
  localStorage.removeItem(POSTS_KEY);
  localStorage.removeItem(REPORTS_KEY);
  localStorage.removeItem(DELETED_KEY);
}
