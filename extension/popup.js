const MEMO_URL = "https://dr-sakamoto.github.io/memo/";
const $ = (id) => document.getElementById(id);

async function renderStats() {
  const { items = {} } = await chrome.storage.local.get("items");
  const all = Object.values(items);
  const pending = all.filter((it) => !it.sent).length;
  const by = {};
  all.forEach((it) => { by[it.source] = (by[it.source] || 0) + 1; });
  const parts = Object.entries(by).map(([s, n]) => `${s} ${n}`).join(" / ");
  $("stats").innerHTML = `集めた投稿 <b>${all.length}</b>件 ${parts ? `（${parts}）` : ""}<br>MEMOへ未送信 <b>${pending}</b>件`;
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "getSettings" });
  $("enabledX").checked = Boolean(s.enabled?.x);
  $("mode").value = s.mode || "all";
  $("handleX").value = s.handles?.x || "";
  $("handle755").value = s.handles?.["755"] || "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = tab?.url?.match(/^https:\/\/7gogo\.jp\/([^/?#]+)/);
  if (m && !["talks", "search", "settings"].includes(m[1])) {
    $("trackHereRow").hidden = false;
    $("talkCode").textContent = m[1];
  }
  renderStats();
  renderTracks();
}

function fmtTime(iso) {
  if (!iso) return "未取得";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 追跡リストの描画（名前はサイト由来なので textContent で入れる）
async function renderTracks() {
  const tracks = (await chrome.runtime.sendMessage({ type: "track755List" })) || {};
  const ul = $("trackList");
  ul.replaceChildren();
  const ids = Object.keys(tracks);
  if (ids.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "まだ登録していません";
    ul.append(li);
    return;
  }
  for (const id of ids) {
    const t = tracks[id];
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "t-main";
    const name = document.createElement("div");
    name.className = "t-name";
    name.textContent = `${t.name || id}（${t.talkName || id}）`;
    const sub = document.createElement("div");
    sub.className = t.lastError ? "muted t-err" : "muted";
    sub.textContent = t.lastError
      ? `取得できませんでした: ${t.lastError}`
      : `最終確認 ${fmtTime(t.lastCheckedAt)}・取り込み ${t.count || 0}件`;
    main.append(name, sub);
    const refresh = document.createElement("button");
    refresh.textContent = "更新";
    refresh.addEventListener("click", () => run(refresh, { type: "track755Refresh", talkId: id }, (r) => `${id}: ${r.error ? "取得できませんでした" : `新着${r.added}件`}`));
    const del = document.createElement("button");
    del.textContent = "外す";
    del.addEventListener("click", async () => {
      if (!confirm(`${t.name || id} を追跡リストから外しますか？（取り込み済みの投稿は消えません）`)) return;
      await chrome.runtime.sendMessage({ type: "track755Remove", talkId: id });
      renderTracks();
    });
    li.append(main, refresh, del);
    ul.append(li);
  }
}

// ボタンを押している間は無効化し、結果を msg に出す
async function run(btn, message, describe) {
  btn.disabled = true;
  $("msg").textContent = "取得中…（初回は時間がかかります）";
  try {
    const res = await chrome.runtime.sendMessage(message);
    $("msg").textContent = res?.error && !("added" in res) ? `できませんでした: ${res.error}` : describe(res || {});
  } catch (err) {
    $("msg").textContent = `できませんでした: ${err.message}`;
  }
  btn.disabled = false;
  renderStats();
  renderTracks();
}

const addedMsg = (r) =>
  `${r.name}${r.talkName ? `「${r.talkName}」` : ""}を追加しました${r.error ? `。ただし取得に失敗: ${r.error}` : `。${r.added}件を取り込み`}`;

// ---- 検索して追加 ----

let searchQuery = "";
let searchNext = null;

function searchRow({ talkId, name, thumbnailUrl, sub, tracked }) {
  const li = document.createElement("li");
  let icon;
  if (thumbnailUrl) {
    icon = document.createElement("img");
    icon.src = thumbnailUrl;
    icon.alt = "";
    icon.referrerPolicy = "no-referrer";
    // 画像が読めないときは無地の丸に差し替える
    icon.addEventListener("error", () => {
      const ph = document.createElement("span");
      ph.className = "s-noimg";
      icon.replaceWith(ph);
    }, { once: true });
  } else {
    icon = document.createElement("span");
    icon.className = "s-noimg";
  }
  const main = document.createElement("div");
  main.className = "s-main";
  const n = document.createElement("div");
  n.className = "s-name";
  n.textContent = name;
  const s = document.createElement("div");
  s.className = "muted s-sub";
  s.textContent = sub;
  main.append(n, s);
  const btn = document.createElement("button");
  btn.textContent = tracked ? "追加済み" : "追加";
  btn.disabled = tracked;
  if (!tracked) {
    btn.className = "primary";
    btn.addEventListener("click", async () => {
      await run(btn, { type: "track755Add", input: talkId }, addedMsg);
      if (!/^できませんでした/.test($("msg").textContent)) {
        btn.textContent = "追加済み";
        btn.className = "";
        btn.disabled = true;
      }
    });
  }
  li.append(icon, main, btn);
  return li;
}

async function doSearch({ more = false } = {}) {
  const input = $("trackInput").value.trim();
  if (!input) return;
  // URLが貼られたら検索せずにそのまま追加
  if (!more && /7gogo\.jp\//.test(input)) {
    $("searchBox").hidden = true;
    await run($("trackSearch"), { type: "track755Add", input }, addedMsg);
    $("trackInput").value = "";
    return;
  }
  if (!more) {
    searchQuery = input;
    searchNext = null;
    $("searchList").replaceChildren();
  }
  const btn = more ? $("searchMore") : $("trackSearch");
  btn.disabled = true;
  $("searchBox").hidden = false;
  $("searchInfo").textContent = "検索中…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "search755", query: searchQuery, offset: more ? searchNext : 0 });
    if (res?.error) throw new Error(res.error);
    const list = $("searchList");
    // IDそのものが入力された場合に備えて「IDとして追加」の行を先頭に出す
    if (!more && /^[A-Za-z0-9_-]{6,64}$/.test(searchQuery) && !res.list.some((t) => t.talkId === searchQuery)) {
      list.append(searchRow({ talkId: searchQuery, name: `ID「${searchQuery}」のトーク`, sub: "IDとして直接追加します", tracked: false }));
    }
    for (const t of res.list) {
      const parts = [t.talkId, `フォロワー ${t.watchCount.toLocaleString()}`];
      if (t.updatedAt) parts.push(`更新 ${fmtTime(t.updatedAt)}`);
      list.append(searchRow({ talkId: t.talkId, name: t.name || t.talkId, thumbnailUrl: t.thumbnailUrl, sub: parts.join("・"), tracked: t.tracked }));
    }
    searchNext = res.nextOffset;
    const shown = list.children.length;
    $("searchInfo").textContent = res.hitCount
      ? `「${searchQuery}」の検索結果 ${res.hitCount.toLocaleString()}件（${shown}件を表示）`
      : `「${searchQuery}」に一致するトークは見つかりませんでした`;
    $("searchMoreRow").hidden = searchNext == null;
  } catch (err) {
    $("searchInfo").textContent = `検索できませんでした: ${err.message}`;
  }
  btn.disabled = false;
}

$("trackSearch").addEventListener("click", () => doSearch());
$("trackInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) doSearch();
});
$("searchMore").addEventListener("click", () => doSearch({ more: true }));

$("trackHere").addEventListener("click", () => {
  run($("trackHere"), { type: "track755Add", input: $("talkCode").textContent }, addedMsg);
});

$("trackRefreshAll").addEventListener("click", () => {
  run($("trackRefreshAll"), { type: "track755Refresh" }, (r) =>
    `${r.talks}件のトークを確認・新着${r.added}件${r.errors?.length ? `（失敗 ${r.errors.length}件）` : ""}`);
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    settings: {
      enabled: { x: $("enabledX").checked },
      mode: $("mode").value,
      handles: { x: $("handleX").value.trim(), "755": $("handle755").value.trim() },
    },
  });
  $("msg").textContent = "保存しました";
});

$("openMemo").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ url: [MEMO_URL + "*", "http://localhost/*", "http://127.0.0.1/*"] });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.tabs.reload(tabs[0].id);
  } else {
    await chrome.tabs.create({ url: MEMO_URL });
  }
});

$("export").addEventListener("click", async () => {
  const { items = {} } = await chrome.storage.local.get("items");
  const list = Object.values(items).map(({ sent, key, ...rest }) => rest);
  const blob = new Blob([JSON.stringify({ format: "memo-hub/v1", exportedAt: new Date().toISOString(), items: list }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `memo-hub-extension-${Date.now()}.json`;
  a.click();
});

$("clearSent").addEventListener("click", async () => {
  if (!confirm("MEMOへ送信済みの投稿を拡張のストレージから消しますか？（MEMO側のデータは消えません）")) return;
  const { items = {} } = await chrome.storage.local.get("items");
  for (const k of Object.keys(items)) if (items[k].sent) delete items[k];
  await chrome.storage.local.set({ items });
  renderStats();
});

load();
