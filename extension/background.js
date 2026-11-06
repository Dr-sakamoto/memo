// MEMO Hub Collector — バックグラウンド（Service Worker）
//
// 役割:
// - 各サイトのコンテンツスクリプトから届いた投稿を chrome.storage.local に貯める（id で重複排除）
// - MEMOのページ（bridge.js）へ未送信分を渡し、受領（ack）されたら送信済みにする
// - 右クリック「MEMOハブへ送る」で、任意のページの選択テキストを取り込む
// - 755 の追跡リストに登録したトーク（アカウント）を、数時間おきに自動で取得する
//
// データはこのブラウザの中だけに置かれ、MEMOのページ以外へは送られない。

const DEFAULT_SETTINGS = {
  enabled: { x: true },
  mode: "all",              // "all" = 表示されたものをすべて / "mine" = 自分の投稿だけ
  handles: { x: "", "755": "" },
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    enabled: { ...DEFAULT_SETTINGS.enabled, ...(settings?.enabled || {}) },
    handles: { ...DEFAULT_SETTINGS.handles, ...(settings?.handles || {}) },
  };
}

function norm(h) {
  return String(h || "").trim().replace(/^@/, "").toLowerCase();
}

function handleSet(settings, source) {
  return new Set(String(settings.handles?.[source] || "").split(/[,\s、]+/).map(norm).filter(Boolean));
}

// 書き込みを直列化（複数タブから同時に届いても取りこぼさない）
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function updateBadge(items) {
  const pending = Object.values(items).filter((it) => !it.sent).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  await chrome.action.setBadgeText({ text: pending ? (pending > 999 ? "999+" : String(pending)) : "" });
}

function storeItems(incoming) {
  return serial(async () => {
    const settings = await getSettings();
    const { items = {} } = await chrome.storage.local.get("items");
    let added = 0;
    for (const raw of incoming || []) {
      if (!raw || !raw.source || !raw.sourceId || !String(raw.text || "").trim()) continue;
      const mine = handleSet(settings, raw.source);
      const isMine = Boolean(raw.isMine) || (mine.size > 0 && mine.has(norm(raw.author)));
      // 「自分の投稿だけ」でも、追跡リストに登録したトーク（明示的に選んだアカウント）は残す
      if (settings.mode === "mine" && raw.source !== "web" && !isMine && !raw.tracked) continue;
      const key = `${raw.source}:${raw.sourceId}`;
      const prev = items[key];
      const next = { ...prev, ...raw, key, isMine, capturedAt: new Date().toISOString() };
      // 本文・メトリクスに変化があれば再送対象にする
      const changed = !prev || prev.text !== next.text || JSON.stringify(prev.metrics) !== JSON.stringify(next.metrics);
      next.sent = prev ? (changed ? false : prev.sent) : false;
      if (!prev) added++;
      items[key] = next;
    }
    await chrome.storage.local.set({ items });
    await updateBadge(items);
    return { added };
  });
}

function markSent(keys) {
  return serial(async () => {
    const { items = {} } = await chrome.storage.local.get("items");
    for (const k of keys || []) if (items[k]) items[k].sent = true;
    await chrome.storage.local.set({ items });
    await updateBadge(items);
  });
}

async function pendingItems(limit = 500) {
  const { items = {} } = await chrome.storage.local.get("items");
  return Object.values(items).filter((it) => !it.sent).slice(0, limit);
}

// ---- 755: アカウント（トーク）単位の追跡 ----
//
// 755はユーザーごとに「トーク」（7gogo.jp/<トークID>）を持つ。公式Webが使っているAPIは
// ログイン不要で、次の3つを使う（2026-11 に実際の応答で確認）:
//   GET /web/v2/talks/<id>                              … トーク情報（data.user.name）
//   GET /web/v2/talks/<id>/posts?direction=PREV&targetId=N … N 以下を新しい順（N を含む）
//   GET /web/v2/talks/<id>/posts?direction=NEXT&targetId=N … N 以上を古い順（N を含む）
// 追跡リスト（chrome.storage.local の tracks）に登録したトークを、数時間おきに新着だけ取りに行く。
// 初回は新しい方から最大3000件さかのぼる。

const API_755 = "https://api.7gogo.jp/web/v2/talks";
const PAGE_LIMIT = 100;
const MAX_PAGES = 30;              // 1回の取得で最大 3000 件
const TRACK_ALARM = "memo-hub-track755";
const TRACK_INTERVAL_MIN = 180;    // 3時間おき
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function text755(body) {
  const parts = [];
  for (const b of body || []) {
    if (b.bodyType === 1 && b.text) parts.push(b.text);                 // テキスト
    else if (b.bodyType === 4 && b.post) parts.push("🔁 " + text755(b.post.body)); // リトーク
    else if (b.bodyType === 3) parts.push("🖼");                        // 画像
    else if (b.bodyType === 2) parts.push("（スタンプ）");
    else if (b.text) parts.push(b.text);
  }
  return parts.join("\n").trim();
}

// URL（https://7gogo.jp/abc/123 など）やIDから、トークIDだけを取り出す
function talkIdOf(input) {
  const s = String(input || "").trim();
  const m = s.match(/7gogo\.jp\/([^/?#\s]+)/);
  const id = (m ? m[1] : s).replace(/^@/, "");
  return /^[A-Za-z0-9_.-]{1,64}$/.test(id) ? id : "";
}

async function get755(path) {
  const res = await fetch(`${API_755}/${path}`);
  if (res.status === 400 || res.status === 404) throw new Error("そのトークIDは見つかりませんでした");
  if (!res.ok) throw new Error(`755に接続できませんでした（HTTP ${res.status}）`);
  const json = await res.json();
  if (json.error && !json.data) throw new Error("755 API: トークが見つからないか、取得できませんでした");
  return json.data;
}

function rowsToItems(talkId, rows, isMine) {
  const out = [];
  for (const row of rows) {
    const post = row.post || row;
    if (post.postId == null || post.deleted) continue;
    const text = text755(post.body);
    if (!text) continue;
    out.push({
      source: "755",
      sourceId: `${talkId}-${post.postId}`,
      author: talkId,
      authorName: row.user?.name || "",
      text,
      url: `https://7gogo.jp/${talkId}/${post.postId}`,
      createdAt: new Date(Number(post.time) * 1000).toISOString(),
      isMine,
      tracked: true,
      isRepost: (post.body || []).some((b) => b.bodyType === 4),
      metrics: {
        like: Number(post.likeCount) || undefined,
        reply: Number(post.commentCount) || undefined,
        repost: Number(post.rtCount) || undefined,
      },
    });
  }
  return out;
}

// 1トークを同期する。返り値 { added, lastPostId }
async function syncTalk(talkId, track = {}) {
  const settings = await getSettings();
  const isMine = handleSet(settings, "755").has(norm(talkId));
  let lastPostId = Number(track.lastPostId) || 0;
  let fetched = 0;

  if (!lastPostId) {
    // 初回: 新しい方からさかのぼる（PREV は targetId 自身を含むので、次は minId - 1 から）
    let targetId = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ limit: String(PAGE_LIMIT), direction: "PREV" });
      if (targetId != null) q.set("targetId", String(targetId));
      const rows = (await get755(`${encodeURIComponent(talkId)}/posts?${q}`)) || [];
      if (rows.length === 0) break;
      const ids = rows.map((r) => Number((r.post || r).postId)).filter(Number.isFinite);
      lastPostId = Math.max(lastPostId, ...ids);
      const items = rowsToItems(talkId, rows, isMine);
      await storeItems(items);
      fetched += items.length;
      const minId = Math.min(...ids);
      if (rows.length < PAGE_LIMIT || minId <= 1) break;
      targetId = minId - 1;
      await sleep(600); // 先方に負荷をかけない間隔
    }
  } else {
    // 2回目以降: 前回の最新より後ろだけ（NEXT は targetId 自身を含むので +1 から）
    let targetId = lastPostId + 1;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ limit: String(PAGE_LIMIT), direction: "NEXT", targetId: String(targetId) });
      const rows = ((await get755(`${encodeURIComponent(talkId)}/posts?${q}`)) || [])
        .filter((r) => Number((r.post || r).postId) > lastPostId);
      if (rows.length === 0) break;
      const ids = rows.map((r) => Number((r.post || r).postId)).filter(Number.isFinite);
      const newest = Math.max(...ids);
      const items = rowsToItems(talkId, rows, isMine);
      await storeItems(items);
      fetched += items.length;
      lastPostId = Math.max(lastPostId, newest);
      if (rows.length < PAGE_LIMIT) break;
      targetId = newest + 1;
      await sleep(600);
    }
  }
  return { added: fetched, lastPostId };
}

async function getTracks() {
  const { tracks = {} } = await chrome.storage.local.get("tracks");
  return tracks;
}

function saveTrack(talkId, patch) {
  return serial(async () => {
    const tracks = await getTracks();
    if (patch === null) delete tracks[talkId];
    else tracks[talkId] = { ...(tracks[talkId] || {}), ...patch };
    await chrome.storage.local.set({ tracks });
    return tracks;
  });
}

async function addTrack(input) {
  const talkId = talkIdOf(input);
  if (!talkId) throw new Error("トークIDかURL（https://7gogo.jp/〇〇）を入れてください");
  const info = await get755(encodeURIComponent(talkId)); // 実在確認と名前の取得
  const name = info?.user?.name || talkId;
  await saveTrack(talkId, { name, addedAt: new Date().toISOString() });
  const res = await refreshTrack(talkId);
  return { talkId, name, ...res };
}

let refreshing = Promise.resolve();
// 1トークを更新して、結果（最終確認・件数・エラー）を追跡リストに記録する
function refreshTrack(talkId) {
  const run = async () => {
    const track = (await getTracks())[talkId];
    if (!track) return { added: 0 };
    try {
      const { added, lastPostId } = await syncTalk(talkId, track);
      await saveTrack(talkId, {
        lastPostId,
        lastCheckedAt: new Date().toISOString(),
        lastError: "",
        count: (track.count || 0) + added,
      });
      return { added };
    } catch (err) {
      await saveTrack(talkId, { lastCheckedAt: new Date().toISOString(), lastError: String(err.message || err) });
      return { added: 0, error: String(err.message || err) };
    }
  };
  // 複数トークの更新は直列に（同時に叩かない）
  const p = refreshing.then(run, run);
  refreshing = p.catch(() => {});
  return p;
}

async function refreshAllTracks() {
  const ids = Object.keys(await getTracks());
  let added = 0;
  const errors = [];
  for (const id of ids) {
    const r = await refreshTrack(id);
    added += r.added || 0;
    if (r.error) errors.push(`${id}: ${r.error}`);
    await sleep(800);
  }
  return { talks: ids.length, added, errors };
}

// 定期更新（Chromeが起動している間、3時間おき）
function ensureAlarm() {
  chrome.alarms.get(TRACK_ALARM, (a) => {
    if (!a) chrome.alarms.create(TRACK_ALARM, { delayInMinutes: 1, periodInMinutes: TRACK_INTERVAL_MIN });
  });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === TRACK_ALARM) refreshAllTracks();
});
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

// ---- 右クリック: 選択テキストを送る ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "memo-hub-send",
    title: "MEMOハブへ送る",
    contexts: ["selection"],
  });
});

function simpleHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "memo-hub-send" || !info.selectionText) return;
  let host = "";
  try { host = new URL(info.pageUrl).hostname; } catch { /* noop */ }
  const source = /(^|\.)7gogo\.jp$/.test(host) ? "755" : /(^|\.)(x|twitter)\.com$/.test(host) ? "x" : "web";
  await storeItems([{
    source,
    sourceId: "sel-" + simpleHash(info.pageUrl + "\n" + info.selectionText),
    author: source === "web" ? host : "",
    authorName: source === "web" ? host : "",
    text: info.selectionText,
    url: info.pageUrl,
    createdAt: new Date().toISOString(),
    isMine: false,
  }]);
});

// ---- メッセージ ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "capture": return storeItems(msg.items);
      case "pending": return pendingItems(msg.limit);
      case "ack": return markSent(msg.keys);
      case "track755Add": return addTrack(msg.input);
      case "track755Remove": return saveTrack(talkIdOf(msg.talkId), null);
      case "track755Refresh": return msg.talkId ? refreshTrack(talkIdOf(msg.talkId)) : refreshAllTracks();
      case "track755List": return getTracks();
      case "getSettings": return getSettings();
      default: return null;
    }
  })().then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // 非同期応答
});
