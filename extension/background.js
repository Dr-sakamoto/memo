// MEMO Hub Collector — バックグラウンド（Service Worker）
//
// 役割:
// - 各サイトのコンテンツスクリプトから届いた投稿を chrome.storage.local に貯める（id で重複排除）
// - MEMOのページ（bridge.js）へ未送信分を渡し、受領（ack）されたら送信済みにする
// - 右クリック「MEMOハブへ送る」で、任意のページの選択テキストを取り込む
// - 755 のトークを公式Web API から取得する（実験的）
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
      if (settings.mode === "mine" && raw.source !== "web" && !isMine) continue;
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

// ---- 755（実験的）: 公式Webが使っている API からトークの投稿を遡って取得 ----

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

async function fetch755(talkCode, { maxPages = 30 } = {}) {
  const settings = await getSettings();
  const mine = handleSet(settings, "755").has(norm(talkCode));
  let targetId = null;
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: "100", direction: "PREV" });
    if (targetId != null) q.set("targetId", String(targetId));
    const res = await fetch(`https://api.7gogo.jp/web/v2/talks/${encodeURIComponent(talkCode)}/posts?${q}`);
    if (!res.ok) throw new Error(`755 API: HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json.data) ? json.data : [];
    if (rows.length === 0) break;
    const batch = [];
    let minId = Infinity;
    for (const row of rows) {
      const post = row.post || row;
      if (post.postId == null) continue;
      minId = Math.min(minId, Number(post.postId));
      const text = text755(post.body);
      if (!text) continue;
      batch.push({
        source: "755",
        sourceId: `${talkCode}-${post.postId}`,
        author: talkCode,
        authorName: row.user?.name || "",
        text,
        url: `https://7gogo.jp/${talkCode}/${post.postId}`,
        createdAt: new Date(Number(post.time) * 1000).toISOString(),
        isMine: mine,
        metrics: { like: Number(post.likeCount) || undefined, reply: Number(post.commentCount) || undefined },
      });
    }
    await storeItems(batch);
    total += batch.length;
    if (!Number.isFinite(minId) || minId <= 1 || minId === targetId) break;
    targetId = minId;
    await new Promise((r) => setTimeout(r, 600)); // 先方に負荷をかけない間隔
  }
  return { total };
}

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
      case "fetch755": return fetch755(msg.talkCode);
      case "getSettings": return getSettings();
      default: return null;
    }
  })().then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // 非同期応答
});
