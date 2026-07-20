// データ層 — すべてlocalStorageに保存する（Closed Network の核）

const POSTS_KEY = "cns.posts.v1";
const SETTINGS_KEY = "cns.settings.v1";

export const KINDS = ["日記", "反省", "分析", "計画", "思考"];

export const MOODS = [
  { value: 2,  emoji: "😄" },
  { value: 1,  emoji: "🙂" },
  { value: 0,  emoji: "😐" },
  { value: -1, emoji: "😞" },
  { value: -2, emoji: "😢" },
];

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

let posts = load(POSTS_KEY, []);
let settings = load(SETTINGS_KEY, {
  apiKey: "",
  model: "claude-opus-4-8",
  aiAutoReply: false,
});

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
export function addPost({ text, kind, mood, type = "post", refId = null }) {
  const post = {
    id: newId(),
    type,
    text: text || "",
    kind: kind || KINDS[0],
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
}

export function setAiReply(id, text) {
  const post = getPost(id);
  if (!post) return;
  post.aiReply = { text, at: new Date().toISOString() };
  save(POSTS_KEY, posts);
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
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), posts, settings: { model: settings.model } }, null, 2);
}

export function importJson(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data.posts)) throw new Error("不正なファイル形式です");
  posts = data.posts;
  save(POSTS_KEY, posts);
}

export function wipeAll() {
  posts = [];
  localStorage.removeItem(POSTS_KEY);
}
