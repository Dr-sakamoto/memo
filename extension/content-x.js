// X（旧Twitter）の画面に表示された投稿を読み取り、拡張のストレージへ送る。
// 読むだけで、Xへは何も書き込まない・クリックもしない。画面の構造（data-testid）が
// 変わると取れなくなることがある。

(() => {
  let settings = null;
  const seen = new Map(); // key -> signature（同じ内容を何度も送らない）

  function textOf(node) {
    if (!node) return "";
    let out = "";
    node.childNodes.forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) out += c.textContent;
      else if (c.nodeName === "IMG") out += c.alt || "";          // 絵文字は画像になっている
      else if (c.nodeName === "BR") out += "\n";
      else if (c.nodeType === Node.ELEMENT_NODE) out += textOf(c);
    });
    return out;
  }

  function num(label) {
    const m = String(label || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([万千KkMm]?)/);
    if (!m) return undefined;
    let v = parseFloat(m[1]);
    const unit = m[2];
    if (unit === "万") v *= 10000;
    else if (unit === "千" || unit === "K" || unit === "k") v *= 1000;
    else if (unit === "M" || unit === "m") v *= 1000000;
    return Math.round(v);
  }

  function metric(article, ids) {
    for (const id of ids) {
      const el = article.querySelector(`[data-testid="${id}"]`);
      if (el) return num(el.getAttribute("aria-label")) ?? 0;
    }
    return undefined;
  }

  function parseArticle(article) {
    const time = article.querySelector('a[href*="/status/"] time');
    const link = time?.closest("a");
    const m = link?.getAttribute("href")?.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const [, handle, id] = m;
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textOf(textEl).trim();
    const nameEl = article.querySelector('[data-testid="User-Name"]');
    const authorName = nameEl ? (textOf(nameEl.querySelector("a") || nameEl).split("@")[0] || "").trim() : "";
    const social = article.querySelector('[data-testid="socialContext"]')?.textContent || "";
    const photos = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map((i) => i.src).filter(Boolean);
    const views = article.querySelector('a[href$="/analytics"]')?.getAttribute("aria-label");
    return {
      source: "x",
      sourceId: id,
      author: handle,
      authorName,
      text: text || (photos.length ? "🖼" : ""),
      url: `https://x.com/${handle}/status/${id}`,
      createdAt: time.getAttribute("datetime"),
      isRepost: /repost|リポスト/i.test(social),
      media: photos,
      metrics: {
        reply: metric(article, ["reply"]),
        repost: metric(article, ["retweet", "unretweet"]),
        like: metric(article, ["like", "unlike"]),
        view: num(views),
      },
    };
  }

  function scan() {
    if (!settings?.enabled?.x) return;
    const batch = [];
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      try {
        const it = parseArticle(a);
        if (!it || !it.text) return;
        const key = `x:${it.sourceId}`;
        const sig = it.text + JSON.stringify(it.metrics);
        if (seen.get(key) === sig) return;
        seen.set(key, sig);
        batch.push(it);
      } catch { /* 1件の失敗で全体を止めない */ }
    });
    if (batch.length) chrome.runtime.sendMessage({ type: "capture", items: batch }).catch(() => {});
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, 800);
  }

  chrome.runtime.sendMessage({ type: "getSettings" }).then((s) => {
    settings = s;
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) {
      chrome.runtime.sendMessage({ type: "getSettings" }).then((s) => { settings = s; schedule(); }).catch(() => {});
    }
  });
})();
