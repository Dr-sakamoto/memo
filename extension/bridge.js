// MEMOのページに挿入され、拡張に貯まった投稿をページへ渡す橋。
// ページ（js/hub-ui.js）とは window.postMessage で同一オリジン内だけでやり取りする。

(() => {
  const PAGE = "memo-hub-page";
  const EXT = "memo-hub-ext";
  // MEMOのページかを確認（localhostで別アプリを開いているときに誤送信しない）
  if (!document.getElementById("view-hub")) return;

  const post = (msg) => window.postMessage({ channel: EXT, ...msg }, location.origin);
  let sending = false;

  async function flush() {
    if (sending) return;
    sending = true;
    try {
      const items = await chrome.runtime.sendMessage({ type: "pending", limit: 500 });
      if (Array.isArray(items) && items.length) {
        post({ type: "items", items: items.map(({ sent, ...rest }) => rest) });
      }
    } catch { /* 拡張の更新直後などは無視 */ }
    sending = false;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.channel !== PAGE) return;
    if (d.type === "request") flush();
    if (d.type === "ack" && Array.isArray(d.keys)) {
      // 送信済みにすると storage.onChanged が発火し、残りがあれば続きを flush する
      chrome.runtime.sendMessage({ type: "ack", keys: d.keys }).catch(() => {});
    }
  });

  // 開いている間に新しく集まった分もその場で届ける
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.items) flush();
  });

  post({ type: "hello", version: chrome.runtime.getManifest().version });
  flush();
})();
