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
    name.textContent = `${t.name || id}（${id}）`;
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

$("trackAdd").addEventListener("click", () => {
  const input = $("trackInput").value.trim();
  if (!input) return;
  run($("trackAdd"), { type: "track755Add", input }, (r) => {
    $("trackInput").value = "";
    return `${r.name}（${r.talkId}）を追加しました${r.error ? `。ただし取得に失敗: ${r.error}` : `。${r.added}件を取り込み`}`;
  });
});

$("trackHere").addEventListener("click", () => {
  run($("trackHere"), { type: "track755Add", input: $("talkCode").textContent }, (r) => `${r.name} を追加しました（${r.added}件を取り込み）`);
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
