// アプリシェルのオフラインキャッシュ。データはlocalStorageのみで、SWはUIの資産だけを扱う。
// 更新手順: デプロイでシェルの中身を変えたら CACHE_VERSION を上げること。
// 上げないとブラウザがsw.js自体の変更を検知できず、古いキャッシュが延々と配信され続ける。
const CACHE_VERSION = "v10";
const CACHE_NAME = `memo-shell-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/ai.js",
  "./js/mass.js",
  "./js/report.js",
  "./js/store.js",
  "./js/sync.js",
  "./js/vine.js",
  "./js/workflow.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

// api呼び出しは絶対にキャッシュしない（レスポンスは毎回ネットワークから素通し）
const API_HOSTS = ["api.anthropic.com", "generativelanguage.googleapis.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const urls = SHELL_ASSETS.map((path) => new URL(path, self.registration.scope).href);
      await cache.addAll(urls);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("memo-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    return await fetch(request);
  } catch (err) {
    // オフラインかつ未キャッシュ: 画面遷移リクエストだけはアプリシェルへフォールバックして起動を保証する
    if (request.mode === "navigate") {
      const fallback = await cache.match(new URL("./index.html", self.registration.scope).href);
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (API_HOSTS.includes(url.hostname)) return; // 素通し。respondWithしないのでブラウザが直接ネットワークへ
  // クラウド同期（Supabase）も絶対にキャッシュしない。常に最新をネットワークから取得する。
  if (url.hostname.endsWith(".supabase.co")) return;

  event.respondWith(cacheFirst(request));
});
