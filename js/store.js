// データ層 — すべてlocalStorageに保存する（Closed Network の核）

const POSTS_KEY = "cns.posts.v1";
const SETTINGS_KEY = "cns.settings.v1";
const REPORTS_KEY = "cns.reports.v1";

export const MOODS = [
  { value: 2,  emoji: "😄" },
  { value: 1,  emoji: "🙂" },
  { value: 0,  emoji: "😐" },
  { value: -1, emoji: "😞" },
  { value: -2, emoji: "😢" },
];

const DEFAULT_SETTINGS = {
  provider: "anthropic",            // "anthropic" | "gemini"
  anthropicKey: "",
  anthropicModel: "claude-opus-4-8",
  geminiKey: "",
  geminiModel: "gemini-2.5-flash",
  aiAutoReply: false,
  reportWorkflow: "auto",           // "auto" | "force" | "single"（レポート生成の多段解析モード）
  freeTierRpm: 10,                  // 無料枠対策のAPIレート上限（毎分）
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

let settings = load(SETTINGS_KEY, null);
if (!settings) {
  settings = { ...DEFAULT_SETTINGS };
} else if (settings.anthropicKey === undefined) {
  // v1設定（apiKey/model）からの移行
  settings = {
    ...DEFAULT_SETTINGS,
    anthropicKey: settings.apiKey || "",
    anthropicModel: settings.model || DEFAULT_SETTINGS.anthropicModel,
    aiAutoReply: Boolean(settings.aiAutoReply),
  };
  save(SETTINGS_KEY, settings);
}

export function getPosts() {
  return posts;
}

export function getPost(id) {
  return posts.find((p) => p.id === id) || null;
}

export function getSettings() {
  return settings;
}

export function saveSettings(next) {
  settings = { ...settings, ...next };
  save(SETTINGS_KEY, settings);
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
export function addPost({ text, mood, type = "post", refId = null }) {
  const post = {
    id: newId(),
    type,
    text: text || "",
    kind: "雑記",
    mood: mood ?? null,
    tags: extractTags(text || ""),
    refId,
    repostCount: 0,
    quoteCount: 0,
    aiReply: null,
    createdAt: new Date().toISOString(),
  };
  posts.unshift(post);

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
  notifyMutation();
}

export function setAiReply(id, text) {
  const post = getPost(id);
  if (!post) return;
  post.aiReply = { text, at: new Date().toISOString() };
  save(POSTS_KEY, posts);
  notifyMutation();
}

// ---- レポート（AIによる構造化解釈の蓄積） ----

export function getReports() {
  return reports;
}

export function hasReport(periodKey) {
  return reports.some((r) => r.periodKey === periodKey);
}

export function addReport(report) {
  reports.unshift(report);
  save(REPORTS_KEY, reports);
  notifyMutation();
  return report;
}

export function deleteReport(id) {
  reports = reports.filter((r) => r.id !== id);
  save(REPORTS_KEY, reports);
  notifyMutation();
}

export function newReportId() {
  return newId();
}

// ---- 成長統計 ----

export function activeDays() {
  const days = new Set(posts.map((p) => p.createdAt.slice(0, 10)));
  return days.size;
}

export function firstPostDate() {
  if (posts.length === 0) return null;
  return new Date(posts[posts.length - 1].createdAt);
}

export function daysSinceFirstPost() {
  const first = firstPostDate();
  if (!first) return 0;
  return Math.floor((Date.now() - first.getTime()) / 86400000);
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
  save(POSTS_KEY, posts);
  save(REPORTS_KEY, reports);
  notifyMutation();
}

// クラウド同期がマージ結果を反映するための差し替え。
// リモート由来の適用なので notifyMutation は呼ばない（プッシュのループを避ける）。
export function replaceData({ posts: nextPosts, reports: nextReports }) {
  if (Array.isArray(nextPosts)) {
    posts = nextPosts;
    save(POSTS_KEY, posts);
  }
  if (Array.isArray(nextReports)) {
    reports = nextReports;
    save(REPORTS_KEY, reports);
  }
}

// 同期対象の生データ（AIキーなどの設定は含めない）
export function snapshot() {
  return { posts, reports };
}

export function wipeAll() {
  posts = [];
  reports = [];
  localStorage.removeItem(POSTS_KEY);
  localStorage.removeItem(REPORTS_KEY);
}
