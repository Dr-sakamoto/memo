// クラウド同期層 — スマホ⇔PCで雑記とレポートを共有する。
//
// 設計思想（「完全ローカル・依存ゼロ・中間サーバーなし」）を保つため:
//   - ライブラリを使わず、Supabase の Auth(GoTrue) と REST(PostgREST) を fetch で直接叩く
//   - 接続先(URL / 公開キー)はユーザー自身が用意した Supabase を設定タブで入力する
//   - 保存されるのは雑記＋レポートのみ。AI APIキーなどの設定は同期しない（端末ローカルのまま）
//   - RLS により、各ユーザーは自分の1行しか読み書きできない
//
// マージ方針: 端末Aと端末Bのデータを id で突き合わせて和集合を取る（データを失わない）。
//   削除は「墓標（削除済みid一覧）」として同期し、和集合を取ったあとに
//   墓標に載っているidを除外することで、他端末に残っていても復活しないようにする。

import { snapshot, replaceData } from "./store.js";
import { externalSnapshot, replaceExternal, hubPrefsSnapshot } from "./hub.js";

const CONFIG_KEY = "cns.sync.config.v1";   // { url, anonKey, autoSync }
const SESSION_KEY = "cns.sync.session.v1"; // { access_token, refresh_token, expires_at, user }

// 既定の接続先。開発者があらかじめ用意したSupabaseプロジェクトを指す。
// これにより利用者は接続先の入力を省き、ログインするだけで同期できる。
// ここで使う anon(publishable) キーは「公開前提」の値で、RLSによって
// ログイン本人の1行しか読み書きできないため、リポジトリに含めても安全。
// 自分のSupabaseを使いたい場合は設定タブの「接続先の設定」で上書きできる。
const DEFAULT_URL = "https://hpajnjqgqfgqeykdvnlw.supabase.co";
const DEFAULT_ANON_KEY = "sb_publishable_kqZK4stgejuqBOf3Pf6zwA_zY8Yq6v7";

// ---- 内部状態 ----

let onApplied = () => {};      // マージ適用後に画面を再描画するコールバック
let syncing = false;
let lastSyncAt = null;
let lastError = null;
let pushTimer = null;

// ---- 設定 / セッションの永続化 ----

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getConfig() {
  const c = readJson(CONFIG_KEY) || {};
  const url = (c.url || DEFAULT_URL || "").replace(/\/+$/, "");
  const anonKey = c.anonKey || DEFAULT_ANON_KEY || "";
  return { url, anonKey, autoSync: c.autoSync !== false };
}

export function saveConfig(next) {
  const cur = getConfig();
  const merged = { ...cur, ...next };
  merged.url = (merged.url || "").trim().replace(/\/+$/, "");
  merged.anonKey = (merged.anonKey || "").trim();
  localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
}

function getSession() {
  return readJson(SESSION_KEY);
}

function saveSession(session) {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  // expires_at はエポック秒。無ければ expires_in から算出する。
  const expiresAt = session.expires_at
    ? session.expires_at
    : Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: expiresAt,
    user: session.user ? { id: session.user.id, email: session.user.email } : null,
  }));
}

// ---- 状態の問い合わせ ----

export function isConfigured() {
  const { url, anonKey } = getConfig();
  return Boolean(url && anonKey);
}

export function isLoggedIn() {
  const s = getSession();
  return Boolean(s && s.access_token && s.user);
}

export function getSyncState() {
  const cfg = getConfig();
  const s = getSession();
  return {
    configured: isConfigured(),
    loggedIn: isLoggedIn(),
    email: s?.user?.email || "",
    autoSync: cfg.autoSync,
    syncing,
    lastSyncAt,
    lastError,
  };
}

// ---- 低レベル HTTP ----

function authBase() {
  const { url } = getConfig();
  return `${url}/auth/v1`;
}
function restBase() {
  const { url } = getConfig();
  return `${url}/rest/v1`;
}

async function parseError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    msg = body.error_description || body.msg || body.message || body.error || msg;
  } catch { /* テキストでない場合は無視 */ }
  return new Error(msg);
}

// アクセストークンが期限切れ間近なら refresh する。
async function ensureFreshToken() {
  const s = getSession();
  if (!s) throw new Error("ログインしていません");
  const now = Math.floor(Date.now() / 1000);
  if (s.expires_at && s.expires_at - now > 60) return s.access_token;

  // リフレッシュ
  const { anonKey } = getConfig();
  const res = await fetch(`${authBase()}/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!res.ok) {
    saveSession(null);
    throw new Error("セッションの有効期限が切れました。再ログインしてください。");
  }
  const data = await res.json();
  saveSession(data);
  return data.access_token;
}

// ---- 認証 ----

export async function signIn(email, password) {
  const { anonKey } = getConfig();
  const res = await fetch(`${authBase()}/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  saveSession(data);
}

export async function signUp(email, password) {
  const { anonKey } = getConfig();
  const res = await fetch(`${authBase()}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  // メール確認が無効なら access_token が返る。有効なら確認待ち。
  if (data.access_token) {
    saveSession(data);
    return { needsConfirmation: false };
  }
  return { needsConfirmation: true };
}

export async function signOut() {
  const s = getSession();
  const { anonKey } = getConfig();
  if (s?.access_token) {
    // ベストエフォート。失敗してもローカルセッションは破棄する。
    try {
      await fetch(`${authBase()}/logout`, {
        method: "POST",
        headers: { apikey: anonKey, Authorization: `Bearer ${s.access_token}` },
      });
    } catch { /* 無視 */ }
  }
  saveSession(null);
  lastSyncAt = null;
  lastError = null;
}

// ---- データ同期（PostgREST） ----

async function pullRemote(token, userId) {
  const { anonKey } = getConfig();
  const res = await fetch(`${restBase()}/memo_state?select=data&user_id=eq.${userId}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await parseError(res);
  const rows = await res.json();
  const data = rows[0]?.data || {};
  return {
    posts: data.posts || [],
    reports: data.reports || [],
    deletedPostIds: data.deletedPostIds || {},
    deletedReportIds: data.deletedReportIds || {},
    external: data.external || [],
    deletedExternalIds: data.deletedExternalIds || {},
    hubPrefs: data.hubPrefs || null,
  };
}

async function pushRemote(token, userId, data) {
  const { anonKey } = getConfig();
  const res = await fetch(`${restBase()}/memo_state`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ user_id: userId, data, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw await parseError(res);
}

// ---- ルーティンの受け取り箱（memo_inbox） ----
// Claudeのルーティンが醸造したレポートはここに置かれる（docs/supabase-routine.sql）。
// 同期のたびに取り込み、通常のレポートと同じ列に合流させてから箱を空にする。
// テーブルが未作成のプロジェクトでも同期全体は止めない（取り込みだけ諦める）。

async function pullInbox(token, userId) {
  const { anonKey } = getConfig();
  const res = await fetch(`${restBase()}/memo_inbox?select=id,payload&kind=eq.report&user_id=eq.${userId}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.map((r) => r.payload).filter((p) => p && p.id && p.periodKey && p.data);
}

async function clearInbox(token, ids) {
  if (ids.length === 0) return;
  const { anonKey } = getConfig();
  const list = ids.map((id) => `"${String(id).replaceAll('"', "")}"`).join(",");
  await fetch(`${restBase()}/memo_inbox?id=in.(${encodeURIComponent(list)})`, {
    method: "DELETE",
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

// 受け取り箱のレポートを remote.reports に混ぜる（＝他端末から届いたレポートと同じ扱い）。
// 同じ期間のレポートが既にあれば（アプリ内でも生成済みなど）重複させずに捨てる。
function absorbInbox(remote, localReports, inboxReports) {
  const keys = new Set([...(remote.reports || []), ...(localReports || [])].map((r) => r.periodKey));
  const ids = new Set([...(remote.reports || []), ...(localReports || [])].map((r) => r.id));
  const fresh = inboxReports.filter((r) => !keys.has(r.periodKey) && !ids.has(r.id));
  return { ...remote, reports: [...(remote.reports || []), ...fresh] };
}

// ---- ルーティン連携トークン ----
// ルーティンはログインせず、このトークンでだけ「読む」「受け取り箱に置く」ができる。
// サーバーにはSHA-256のハッシュだけを保存し、平文は発行時に一度だけ画面に出す。

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function routineTokenStatus() {
  if (!isConfigured() || !isLoggedIn()) return { available: false };
  const token = await ensureFreshToken();
  const { anonKey } = getConfig();
  const res = await fetch(`${restBase()}/memo_routine_tokens?select=created_at&user_id=eq.${getSession().user.id}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { available: false, error: "ルーティン連携用のテーブルがありません（docs/supabase-routine.sql を実行してください）" };
  const rows = await res.json();
  return { available: true, issuedAt: rows[0]?.created_at || null };
}

export async function issueRoutineToken() {
  const token = await ensureFreshToken();
  const { anonKey } = getConfig();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plain = "memo_rt_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(`${restBase()}/memo_routine_tokens`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ user_id: getSession().user.id, token_hash: await sha256Hex(plain), created_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw await parseError(res);
  return plain;
}

export async function revokeRoutineToken() {
  const token = await ensureFreshToken();
  const { anonKey } = getConfig();
  const res = await fetch(`${restBase()}/memo_routine_tokens?user_id=eq.${getSession().user.id}`, {
    method: "DELETE",
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await parseError(res);
}

// ---- マージ（id で和集合。データを失わない） ----

function mergeById(localArr, remoteArr, pick) {
  const map = new Map();
  for (const item of remoteArr || []) if (item && item.id) map.set(item.id, item);
  for (const item of localArr || []) {
    if (!item || !item.id) continue;
    const existing = map.get(item.id);
    map.set(item.id, existing ? pick(existing, item) : item);
  }
  return [...map.values()];
}

// 同じidが両端末にあるとき、より情報量の多い方を残す（AI返信あり・引用/再掲が多い方）
function pickRicherPost(remote, local) {
  const score = (p) => (p.aiReply ? 2 : 0) + (p.quoteCount || 0) + (p.repostCount || 0);
  return score(local) >= score(remote) ? local : remote;
}

// 同じidのレポートが両端末にあるとき、盲点への応答(feedback)が新しい方を残す。
// 無条件にローカル優先だと、端末Aで書いた応答が端末Bとの同期で消えてしまう。
function pickFreshFeedbackReport(remote, local) {
  const at = (r) => r?.feedback?.blindSpot?.at;
  const localAt = at(local);
  const remoteAt = at(remote);
  if (localAt && remoteAt) return new Date(localAt) >= new Date(remoteAt) ? local : remote;
  if (localAt) return local;
  if (remoteAt) return remote;
  return local;
}

function byCreatedAtDesc(a, b) {
  return new Date(b.createdAt) - new Date(a.createdAt);
}

// 削除済みid（墓標）の和集合を取る。一度削除されたidはどちらの端末で
// 見ても削除済み扱いになる。
function mergeDeletedIds(localMap, remoteMap) {
  return { ...(remoteMap || {}), ...(localMap || {}) };
}

function mergeState(local, remote) {
  const deletedPostIds = mergeDeletedIds(local.deletedPostIds, remote.deletedPostIds);
  const deletedReportIds = mergeDeletedIds(local.deletedReportIds, remote.deletedReportIds);

  const posts = mergeById(local.posts, remote.posts, pickRicherPost)
    .filter((p) => !deletedPostIds[p.id])
    .sort(byCreatedAtDesc);
  const reports = mergeById(local.reports, remote.reports, pickFreshFeedbackReport)
    .filter((r) => !deletedReportIds[r.id])
    .sort(byCreatedAtDesc);

  // 統合ハブの外部投稿。この端末で同期OFF（local.external === null）なら、
  // リモートの値をそのまま素通しして保持する（他端末の同期データを消さない）。
  let external = remote.external || [];
  let deletedExternalIds = remote.deletedExternalIds || {};
  if (local.external) {
    deletedExternalIds = mergeDeletedIds(local.deletedExternalIds, remote.deletedExternalIds);
    external = mergeById(local.external, remote.external, pickNewerCapture)
      .filter((it) => !deletedExternalIds[it.id])
      .sort(byCreatedAtDesc);
  }

  // 統合タブの設定のうち「自分の投稿」の判定に必要なもの。ルーティンが醸造の材料を
  // アプリと同じ基準で選べるよう、この端末の値をクラウドに置く（端末側は上書きしない）。
  const hubPrefs = local.hubPrefs || remote.hubPrefs || null;

  return { posts, reports, deletedPostIds, deletedReportIds, external, deletedExternalIds, hubPrefs };
}

// 同じ外部投稿は、後から取得した方（いいね数などが新しい）を残す
function pickNewerCapture(remote, local) {
  return new Date(local.capturedAt || 0) >= new Date(remote.capturedAt || 0) ? local : remote;
}

// ---- 同期の実行 ----

export async function syncNow() {
  if (!isConfigured()) { lastError = "接続先が未設定です"; return getSyncState(); }
  if (!isLoggedIn()) { lastError = "ログインしていません"; return getSyncState(); }
  if (syncing) return getSyncState();

  syncing = true;
  lastError = null;
  try {
    const token = await ensureFreshToken();
    const userId = getSession().user.id;

    const pulled = await pullRemote(token, userId);
    const extLocal = externalSnapshot(); // 同期OFFなら null
    const local = {
      ...snapshot(),
      external: extLocal?.external || null,
      deletedExternalIds: extLocal?.deletedExternalIds || {},
      hubPrefs: hubPrefsSnapshot(),
    };
    const inbox = await pullInbox(token, userId);
    const remote = inbox.length ? absorbInbox(pulled, local.reports, inbox) : pulled;
    const merged = mergeState(local, remote);

    // ローカルに変化があるか（リモートから増えた分・他端末での削除分）を判定
    const localContentChanged =
      JSON.stringify(merged.posts) !== JSON.stringify(local.posts) ||
      JSON.stringify(merged.reports) !== JSON.stringify(local.reports);
    const localDeletedChanged =
      JSON.stringify(merged.deletedPostIds) !== JSON.stringify(local.deletedPostIds) ||
      JSON.stringify(merged.deletedReportIds) !== JSON.stringify(local.deletedReportIds);

    if (localContentChanged || localDeletedChanged) {
      replaceData(merged);
      if (localContentChanged) onApplied();
    }
    if (local.external &&
        (JSON.stringify(merged.external) !== JSON.stringify(local.external) ||
         JSON.stringify(merged.deletedExternalIds) !== JSON.stringify(local.deletedExternalIds))) {
      replaceExternal(merged);
    }

    // リモートにも変化があれば（ローカルからの追加・削除分）プッシュ
    const remoteChanged =
      JSON.stringify(merged.posts) !== JSON.stringify(remote.posts) ||
      JSON.stringify(merged.reports) !== JSON.stringify(remote.reports) ||
      JSON.stringify(merged.deletedPostIds) !== JSON.stringify(remote.deletedPostIds) ||
      JSON.stringify(merged.deletedReportIds) !== JSON.stringify(remote.deletedReportIds) ||
      JSON.stringify(merged.external) !== JSON.stringify(remote.external) ||
      JSON.stringify(merged.deletedExternalIds) !== JSON.stringify(remote.deletedExternalIds) ||
      JSON.stringify(merged.hubPrefs) !== JSON.stringify(remote.hubPrefs) ||
      inbox.length > 0; // 受け取り箱の分は pulled（実際のリモート）に無いので必ず書き戻す

    if (remoteChanged) {
      await pushRemote(token, userId, merged);
    }
    // memo_state に書き戻せてから箱を空にする（途中で失敗しても次回また取り込める）
    if (inbox.length) await clearInbox(token, inbox.map((r) => r.id));

    lastSyncAt = new Date();
  } catch (err) {
    lastError = err.message || String(err);
  } finally {
    syncing = false;
  }
  return getSyncState();
}

// 変更のたびに呼ばれる。まとめて（デバウンスして）同期する。
export function scheduleAutoPush() {
  const cfg = getConfig();
  if (!cfg.autoSync || !isConfigured() || !isLoggedIn()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { syncNow().then(() => onApplied()); }, 1500);
}

export function setAutoSync(on) {
  saveConfig({ autoSync: Boolean(on) });
}

// ---- 初期化 ----

export function initSync({ onApplied: cb } = {}) {
  if (typeof cb === "function") onApplied = cb;

  // 起動時に一度同期
  if (isConfigured() && isLoggedIn()) {
    syncNow().then(() => onApplied());
  }

  // タブが再びアクティブになったら同期（別端末の更新を取り込む）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getConfig().autoSync && isConfigured() && isLoggedIn()) {
      syncNow().then(() => onApplied());
    }
  });
}
