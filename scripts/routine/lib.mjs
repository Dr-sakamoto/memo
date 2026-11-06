// Claudeのルーティン（醸造担当）用の共通処理。依存ゼロ・Node 18+。
// 接続先はアプリと同じ（js/sync.js の既定値）。環境変数で上書きできる:
//   MEMO_SUPABASE_URL / MEMO_SUPABASE_ANON_KEY / MEMO_TZ（既定 Asia/Tokyo）
// 連携トークンはヘッダ x-memo-routine-token で送る。クラウド環境ではネットワーク
// シークレットとしてプロキシが差し込むので、MEMO_ROUTINE_TOKEN は設定しないこと。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TZ = process.env.MEMO_TZ || "Asia/Tokyo"; // 週・月の区切りはアプリ（日本時間）に合わせる

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function defaultsFromApp() {
  const src = readFileSync(join(ROOT, "js", "sync.js"), "utf8");
  return {
    url: src.match(/const DEFAULT_URL = "([^"]+)"/)?.[1] || "",
    anonKey: src.match(/const DEFAULT_ANON_KEY = "([^"]+)"/)?.[1] || "",
  };
}

export function config() {
  const d = defaultsFromApp();
  return {
    url: (process.env.MEMO_SUPABASE_URL || d.url).replace(/\/+$/, ""),
    anonKey: process.env.MEMO_SUPABASE_ANON_KEY || d.anonKey,
  };
}

export async function rpc(name, body = {}) {
  const { url, anonKey } = config();
  const headers = { apikey: anonKey, "Content-Type": "application/json" };
  // クラウド環境ではヘッダを付けずに送る。ネットワークシークレットのプロキシが
  // x-memo-routine-token を差し込む（こちらで仮の値を付けると、それが優先されて失敗する）。
  // 手元で試すときだけ MEMO_ROUTINE_TOKEN で明示的に渡す。
  if (process.env.MEMO_ROUTINE_TOKEN) headers["x-memo-routine-token"] = process.env.MEMO_ROUTINE_TOKEN;
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---- 期間（アプリの js/report.js と同じ規則。週は月曜始まり） ----

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function weekStartOf(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function periodOf(type, from) {
  if (type === "monthly") {
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    return { type, from, to, key: `monthly:${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`, label: `${from.getFullYear()}年${from.getMonth() + 1}月` };
  }
  const to = new Date(from.getTime() + 7 * 86400000);
  const end = new Date(to.getTime() - 1);
  return { type: "weekly", from, to, key: `weekly:${ymd(from)}`, label: `${from.getMonth() + 1}/${from.getDate()}〜${end.getMonth() + 1}/${end.getDate()}の週` };
}

// ---- 醸造プール（アプリの brewPool と同じ基準） ----

const norm = (h) => String(h || "").trim().replace(/^@/, "").toLowerCase();

export function brewPool(data) {
  const memo = (data.posts || [])
    .filter((p) => p && p.text && p.text.trim() && p.type !== "repost")
    .map((p) => ({ id: p.id, source: "memo", type: p.type, text: p.text, createdAt: p.createdAt, mood: p.mood ?? null }));
  const prefs = data.hubPrefs || {};
  if (prefs.brewExternal === false) return memo;
  const handles = {};
  for (const [src, raw] of Object.entries(prefs.myHandles || {})) {
    handles[src] = new Set(String(raw || "").split(/[,\s、]+/).map(norm).filter(Boolean));
  }
  const ext = (data.external || [])
    .filter((it) => it && !it.isRepost && it.text && it.text.trim() && it.text.trim() !== "🖼")
    .filter((it) => it.isMine || handles[it.source]?.has(norm(it.author)))
    .map((it) => ({ id: it.id, source: it.source, type: "post", text: it.text, createdAt: it.createdAt, mood: null }));
  return [...memo, ...ext].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // 古い順
}

export function inRange(list, from, to) {
  return list.filter((p) => {
    const t = new Date(p.createdAt).getTime();
    return t >= from.getTime() && t < to.getTime();
  });
}

const SOURCE_LABEL = { x: "X", "755": "755", web: "Web" };

// アプリの formatPostsForPrompt(withIds) と同じ書式（古い順）
export function formatPosts(posts) {
  return posts.map((p) => {
    const d = new Date(p.createdAt);
    const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const mood = p.mood == null ? "" : ` 気分:${p.mood > 0 ? "+" : ""}${p.mood}`;
    const src = p.source && p.source !== "memo" ? `[${SOURCE_LABEL[p.source] || p.source}]` : "";
    const rt = p.type === "quote" ? "（過去ポストへの引用）" : "";
    return `[id:${p.id}][${date}${mood}]${src}${rt} ${p.text}`;
  }).join("\n");
}

export const ROOT_DIR = ROOT;
