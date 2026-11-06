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
    $("box755").hidden = false;
    $("talkCode").textContent = m[1];
  }
  renderStats();
}

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

$("fetch755").addEventListener("click", async () => {
  const code = $("talkCode").textContent;
  $("fetch755").disabled = true;
  $("msg").textContent = "取得中…（ページ数が多いと時間がかかります）";
  const res = await chrome.runtime.sendMessage({ type: "fetch755", talkCode: code });
  $("fetch755").disabled = false;
  $("msg").textContent = res?.error ? `取得できませんでした: ${res.error}` : `${res.total}件を取得しました`;
  renderStats();
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
