// 統合ハブ — 外部SNS（X / 755 など）の投稿を取り込み、MEMOの雑記と並べて閲覧・分析・抽出する。
//
// 方針:
// - 外部ポストは MEMO の雑記（cns.posts.v1）とは別ストアに置く。ブドウの木の成長・連・
//   レポート・電光掲示板など「自分の雑記」専用のロジックを汚さないため。
// - 取り込み経路は3つ: (1) Chrome拡張（extension/）が閲覧中のページから収集して橋渡し
//   (2) Xの公式アーカイブ（data/tweets.js）のインポート (3) 汎用JSON（拡張のエクスポート等）
// - id は「ソース:ソース内ID」（例: x:1790000000000000000）。同じ投稿を何度取り込んでも重複しない。

const EXTERNAL_KEY = "cns.external.v1";
const HUB_SETTINGS_KEY = "cns.hub.v1";
const DELETED_EXT_KEY = "cns.external.deleted.v1";

export const SOURCES = {
  memo: { label: "MEMO", icon: "🍇", color: "#7c3aed" },
  x:    { label: "X",    icon: "𝕏",  color: "#1f2937" },
  "755": { label: "755", icon: "7️⃣", color: "#e4007f" },
  web:  { label: "Web",  icon: "🌐", color: "#3f78c2" },
};

// 表示順（"755" は数値風のキーなので、オブジェクトの列挙順に任せると先頭に来てしまう）
export const SOURCE_ORDER = ["memo", "x", "755", "web"];

export function sourceMeta(source) {
  return SOURCES[source] || { label: source || "?", icon: "•", color: "#8d84a3" };
}

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

let items = load(EXTERNAL_KEY, []);
let deletedExt = load(DELETED_EXT_KEY, {});
let hubSettings = {
  myHandles: { x: "", "755": "" }, // 「自分の投稿」判定に使うハンドル（カンマ区切り可）
  syncExternal: false,              // クラウド同期に外部ポストも含めるか
  brewExternal: true,               // レポート（醸造）と電光掲示板に、外部SNSの「自分の投稿」も含めるか
  ...load(HUB_SETTINGS_KEY, {}),
};

const listeners = new Set();
export function onHubChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
// meta.remote: クラウド同期由来の反映（自動プッシュの再起動を避けるため購読側で区別する）
function notify(meta = {}) {
  for (const cb of listeners) {
    try { cb(meta); } catch { /* 無視 */ }
  }
}

export function getHubSettings() {
  return hubSettings;
}

export function saveHubSettings(next) {
  hubSettings = { ...hubSettings, ...next, myHandles: { ...hubSettings.myHandles, ...(next.myHandles || {}) } };
  save(HUB_SETTINGS_KEY, hubSettings);
  notify();
}

export function getExternal() {
  return items;
}

function byCreatedAtDesc(a, b) {
  return new Date(b.createdAt) - new Date(a.createdAt);
}

function normHandle(h) {
  return String(h || "").trim().replace(/^@/, "").toLowerCase();
}

export function myHandleSet(source) {
  const raw = hubSettings.myHandles?.[source] || "";
  return new Set(raw.split(/[,\s、]+/).map(normHandle).filter(Boolean));
}

// 自分の投稿か。取り込み時の isMine フラグか、設定したハンドルとの一致で判定する。
export function isMine(item) {
  if (item.source === "memo") return true;
  if (item.isMine) return true;
  const set = myHandleSet(item.source);
  return set.size > 0 && set.has(normHandle(item.author));
}

function extractTags(text) {
  const tags = new Set();
  for (const m of String(text).matchAll(/[#＃]([^\s#＃.,、。!！?？「」()（）]+)/g)) tags.add(m[1]);
  return [...tags];
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = String(raw.source || "web").slice(0, 20);
  const sourceId = String(raw.sourceId ?? raw.id ?? "").replace(/^[^:]+:/, "").slice(0, 200);
  const text = String(raw.text ?? "").slice(0, 20000);
  if (!sourceId || !text.trim()) return null;
  const created = new Date(raw.createdAt || raw.capturedAt || Date.now());
  if (Number.isNaN(created.getTime())) return null;
  let url = raw.url ? String(raw.url) : "";
  if (url && !/^https?:\/\//i.test(url)) url = ""; // javascript: 等は捨てる
  const metrics = {};
  if (raw.metrics && typeof raw.metrics === "object") {
    for (const k of ["reply", "repost", "like", "view"]) {
      const v = Number(raw.metrics[k]);
      if (Number.isFinite(v) && v >= 0) metrics[k] = v;
    }
  }
  return {
    id: `${source}:${sourceId}`,
    source,
    sourceId,
    author: String(raw.author || "").replace(/^@/, "").slice(0, 100),
    authorName: String(raw.authorName || "").slice(0, 200),
    text,
    url,
    createdAt: created.toISOString(),
    capturedAt: new Date(raw.capturedAt || Date.now()).toISOString(),
    isMine: Boolean(raw.isMine),
    isRepost: Boolean(raw.isRepost),
    replyTo: raw.replyTo ? String(raw.replyTo).slice(0, 100) : "",
    media: Array.isArray(raw.media) ? raw.media.filter((m) => /^https:\/\//.test(m)).slice(0, 8) : [],
    metrics,
    tags: extractTags(text),
  };
}

// 取り込み。同じidは「新しく取得した方」でメトリクス等を更新し、isMine は一度立ったら維持する。
export function addExternal(rawItems, { force = false } = {}) {
  const map = new Map(items.map((it) => [it.id, it]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of rawItems || []) {
    const it = sanitizeItem(raw);
    if (!it) { skipped++; continue; }
    if (deletedExt[it.id] && !force) { skipped++; continue; }
    if (force) delete deletedExt[it.id];
    const prev = map.get(it.id);
    if (prev) {
      const merged = {
        ...prev,
        ...it,
        isMine: prev.isMine || it.isMine,
        metrics: { ...prev.metrics, ...it.metrics },
        media: it.media.length ? it.media : prev.media,
      };
      if (JSON.stringify(merged) !== JSON.stringify(prev)) updated++;
      map.set(it.id, merged);
    } else {
      map.set(it.id, it);
      added++;
    }
  }
  if (added || updated) {
    items = [...map.values()].sort(byCreatedAtDesc);
    save(EXTERNAL_KEY, items);
    if (force) save(DELETED_EXT_KEY, deletedExt);
    notify();
  }
  return { added, updated, skipped };
}

export function deleteExternal(id) {
  items = items.filter((it) => it.id !== id);
  deletedExt[id] = new Date().toISOString();
  save(EXTERNAL_KEY, items);
  save(DELETED_EXT_KEY, deletedExt);
  notify();
}

export function clearSource(source) {
  const now = new Date().toISOString();
  items.forEach((it) => { if (it.source === source) deletedExt[it.id] = now; });
  items = items.filter((it) => it.source !== source);
  save(EXTERNAL_KEY, items);
  save(DELETED_EXT_KEY, deletedExt);
  notify();
}

// ---- 醸造プール ----
// つぶやきレベルのアウトプットを一本化する: MEMOの雑記と、外部SNSに書いた自分の投稿を
// 同じ「つぶやき」として並べ、レポート（AIの醸造）と電光掲示板の材料にする。
// 外部投稿は雑記の形（id / text / createdAt / mood / tags）に揃え、source で出自を残す。
export function ownExternalAsPosts() {
  if (!hubSettings.brewExternal) return [];
  return items
    .filter((it) => isMine(it) && !it.isRepost && it.text.trim() && it.text.trim() !== "🖼")
    .map((it) => ({
      id: it.id,
      type: "post",
      source: it.source,
      text: it.text,
      createdAt: it.createdAt,
      mood: null,
      tags: it.tags || [],
      url: it.url || "",
    }));
}

export function getExternalById(id) {
  return items.find((it) => it.id === id) || null;
}

// ---- クラウド同期用 ----

export function externalSnapshot() {
  if (!hubSettings.syncExternal) return null;
  return { external: items, deletedExternalIds: { ...deletedExt } };
}

export function replaceExternal({ external, deletedExternalIds }) {
  if (Array.isArray(external)) {
    items = external.slice().sort(byCreatedAtDesc);
    save(EXTERNAL_KEY, items);
  }
  if (deletedExternalIds) {
    deletedExt = deletedExternalIds;
    save(DELETED_EXT_KEY, deletedExt);
  }
  notify({ remote: true });
}

export function wipeExternal() {
  items = [];
  deletedExt = {};
  localStorage.removeItem(EXTERNAL_KEY);
  localStorage.removeItem(DELETED_EXT_KEY);
  notify();
}

// ---- パーサ ----

// Xの公式アーカイブ（設定 → アカウント → データのアーカイブをダウンロード）の
// data/tweets.js（window.YTD.tweets.part0 = [...]）。part1, part2 ... も同形式。
export function parseXArchive(text, { handle = "" } = {}) {
  const start = text.indexOf("[");
  if (start === -1) throw new Error("tweets.js の形式ではありません");
  const arr = JSON.parse(text.slice(start));
  const h = normHandle(handle || [...myHandleSet("x")][0] || "");
  return arr.map((row) => {
    const t = row.tweet || row;
    const id = t.id_str || t.id;
    const fullText = t.full_text || t.text || "";
    // t.co の短縮URLを展開
    let body = fullText;
    for (const u of t.entities?.urls || []) {
      if (u.url && u.expanded_url) body = body.split(u.url).join(u.expanded_url);
    }
    for (const m of t.entities?.media || []) {
      if (m.url) body = body.split(m.url).join("").trim();
    }
    body = body.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    return {
      source: "x",
      sourceId: id,
      author: h,
      text: body,
      url: h ? `https://x.com/${h}/status/${id}` : `https://x.com/i/web/status/${id}`,
      createdAt: t.created_at,
      isMine: true,
      isRepost: /^RT @/.test(fullText),
      replyTo: t.in_reply_to_screen_name || "",
      metrics: { like: Number(t.favorite_count) || 0, repost: Number(t.retweet_count) || 0 },
      media: (t.extended_entities?.media || t.entities?.media || []).map((m) => m.media_url_https).filter(Boolean),
    };
  });
}

// 汎用JSON: Chrome拡張のエクスポート（{format:"memo-hub/v1", items:[...]}）または配列。
export function parseGenericJson(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : (data.items || data.external || null);
  if (!Array.isArray(arr)) throw new Error("items 配列が見つかりません");
  return arr;
}

// ファイル内容から形式を判定して取り込む
export function importAuto(text, opts = {}) {
  const trimmed = text.trim();
  if (/^window\.YTD\./.test(trimmed)) return addExternal(parseXArchive(trimmed, opts), opts);
  return addExternal(parseGenericJson(trimmed), opts);
}

// ---- 分析 ----

const STOPWORDS = new Set([
  "こと", "もの", "これ", "それ", "あれ", "ここ", "そこ", "ため", "よう", "さん", "ちゃん", "くん",
  "する", "した", "して", "いる", "ある", "なる", "思う", "今日", "自分", "本当", "感じ",
  "the", "and", "for", "you", "that", "this", "with", "are", "was", "have", "https", "http", "com",
]);

// 依存ゼロの簡易トークナイザ: 漢字/カタカナの連続（2文字以上）と英単語（3文字以上）を拾う。
export function tokenize(text) {
  const cleaned = String(text)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@＠][A-Za-z0-9_]+/g, " ")
    .replace(/[#＃][^\s]+/g, " ");
  const out = [];
  for (const m of cleaned.matchAll(/[一-鿿々]{2,}|[゠-ヿー]{2,}|[A-Za-z][A-Za-z0-9'-]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOPWORDS.has(w) && !/^ー+$/.test(w)) out.push(w);
  }
  return out;
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function analyze(list) {
  const bySource = new Map();
  const hours = Array(24).fill(0);
  const weekdays = Array(7).fill(0);
  const months = new Map(); // "YYYY-MM" -> { [source]: n }
  const words = new Map();
  const tags = new Map();
  const mentions = new Map();
  let totalLen = 0;
  let mine = 0;

  for (const it of list) {
    bySource.set(it.source, (bySource.get(it.source) || 0) + 1);
    const d = new Date(it.createdAt);
    hours[d.getHours()]++;
    weekdays[d.getDay()]++;
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!months.has(mk)) months.set(mk, {});
    const mrow = months.get(mk);
    mrow[it.source] = (mrow[it.source] || 0) + 1;
    totalLen += it.text.length;
    if (isMine(it)) mine++;
    for (const w of new Set(tokenize(it.text))) words.set(w, (words.get(w) || 0) + 1);
    for (const t of it.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    for (const m of it.text.matchAll(/[@＠]([A-Za-z0-9_]{1,30})/g)) {
      const k = m[1].toLowerCase();
      mentions.set(k, (mentions.get(k) || 0) + 1);
    }
  }

  return {
    total: list.length,
    mine,
    avgLength: list.length ? Math.round(totalLen / list.length) : 0,
    bySource: topN(bySource, 10),
    hours,
    weekdays,
    months: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    topWords: topN(words, 30),
    topTags: topN(tags, 20),
    topMentions: topN(mentions, 15),
  };
}

// ---- エクスポート ----

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(list) {
  const header = ["source", "createdAt", "author", "isMine", "text", "url", "like", "repost", "reply", "tags"];
  const rows = list.map((it) => [
    it.source, it.createdAt, it.author || "", isMine(it) ? 1 : 0, it.text, it.url || "",
    it.metrics?.like ?? "", it.metrics?.repost ?? "", it.metrics?.reply ?? "", (it.tags || []).join(" "),
  ].map(csvCell).join(","));
  // ExcelでUTF-8を正しく開けるようBOMを付ける
  return "﻿" + [header.join(","), ...rows].join("\r\n");
}

export function toJson(list) {
  return JSON.stringify({ format: "memo-hub/v1", exportedAt: new Date().toISOString(), items: list }, null, 2);
}
