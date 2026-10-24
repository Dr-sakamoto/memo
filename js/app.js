import {
  MOODS,
  getPosts, getPost,
  addPost, deletePost,
  breakThreadLink,
  exportJson, importJson, wipeAll,
  onMutation,
} from "./store.js";
import {
  initSync, getSyncState, saveConfig as saveSyncConfig,
  signIn, signUp, signOut, syncNow, setAutoSync, scheduleAutoPush,
} from "./sync.js";
import {
  ageInDays, anniversaryLabel, pickAnniversaries, pickFlow, findEchoes,
  markSurfaced, mute, mutedCount, unmuteAll, resetSurface,
  dailyCount, DAILY_SOFT_LIMIT,
} from "./flow.js";

const $ = (sel) => document.querySelector(sel);

// ---------- ユーティリティ ----------

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderBody(text) {
  return escapeHtml(text).replace(/#([^\s#<]+)/g, '<span class="tag" data-tag="$1">#$1</span>');
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtAgo(iso) {
  const days = ageInDays({ createdAt: iso });
  if (days < 1 / 24) return "たった今";
  if (days < 1) return `${Math.floor(days * 24)}時間前`;
  if (days < 30) return `${Math.floor(days)}日前`;
  if (days < 365) return `${Math.floor(days / 30)}ヶ月前`;
  return `${(days / 365).toFixed(1)}年前`;
}

// 旧版で記録した気分は表示だけ残す（新しく入力する場所はない）
function moodEmoji(mood) {
  return MOODS.find((m) => m.value === mood)?.emoji || "";
}

// ---------- タブ切り替え ----------

const views = ["home", "log", "settings"];

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  switchView(btn.dataset.view);
});

function switchView(name) {
  views.forEach((v) => {
    $(`#view-${v}`).hidden = v !== name;
  });
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "log") renderFeed();
  if (name === "settings") renderFlowSettings();
}

// ---------- ポストの描画 ----------

// variant:
//   "log"  … 記録タブ（再掲・接ぎ木・削除）
//   "now"  … いま書いた投稿（再掲・接ぎ木・削除）
//   "past" … 流れてきた過去の自分（接ぎ木・再掲・前後を見る・もう流さない）
function postHtml(post, { variant = "log", grouped = false, isCont = false, when = "" } = {}) {
  const ref = post.refId ? getPost(post.refId) : null;

  let repostNote = "";
  let quoteBlock = "";
  if (post.type === "repost" && ref) {
    repostNote = `<div class="repost-note">🔁 過去の自分を再掲</div>`;
  }
  if (ref && (post.type === "quote" || post.type === "repost")) {
    quoteBlock = `<blockquote><span class="q-meta">${fmtDateTime(ref.createdAt)}（${fmtAgo(ref.createdAt)}）</span>${renderBody(ref.text)}</blockquote>`;
  } else if (post.refId && !ref) {
    quoteBlock = `<blockquote><span class="q-meta">（削除されたポスト）</span></blockquote>`;
  }

  const bodyHtml = post.text ? `<div class="post-body">${renderBody(post.text)}</div>` : "";

  const actions = variant === "past" ? `
    <div class="post-actions">
      <button class="pa-btn" data-action="quote" data-id="${post.id}" title="いまの自分を重ねる">🌿 接ぎ木</button>
      <button class="pa-btn" data-action="repost" data-id="${post.id}" title="いまのタイムラインに再掲する">🔁 再掲</button>
      <button class="pa-btn" data-action="context" data-id="${post.id}" title="記録で前後を見る">🧵 前後</button>
      <button class="pa-btn danger" data-action="mute" data-id="${post.id}" title="この投稿をもう流さない">🔕 流さない</button>
    </div>` : `
    <div class="post-actions">
      <button class="pa-btn" data-action="repost" data-id="${post.id}" title="再掲する">🔁 再掲</button>
      <button class="pa-btn" data-action="quote" data-id="${post.id}" title="引用する">🌿 接ぎ木 ${post.quoteCount ? post.quoteCount : ""}</button>
      <button class="pa-btn danger" data-action="delete" data-id="${post.id}">削除</button>
    </div>`;

  // 連（スレッド）の一員として描くときは grouped=true。枠・角丸・余白を外し、
  // 親の .thread ブロックに密着させて「1つのまとまり」に見せる。
  // isCont（連の先頭＝最古以外）には控えめな「↳」で続きを示す。
  const threadClass = grouped ? " thread-item" : "";
  const threadMark = isCont ? `<span class="thread-mark" title="さっきの続き（同じ一息）">↳</span>` : "";

  const pastClass = variant === "past" ? ` past${anniversaryLabel(post) ? " anniv" : ""}` : "";
  const head = variant === "past"
    ? `<span class="past-who">${escapeHtml(when || fmtAgo(post.createdAt))}のあなた</span><span>${fmtDateTime(post.createdAt)}</span>`
    : `${threadMark}<span>${fmtDateTime(post.createdAt)}</span><span>${fmtAgo(post.createdAt)}</span>`;

  return `
  <article class="post${threadClass}${pastClass}" data-id="${post.id}">
    ${repostNote}
    <div class="post-head">
      ${head}
      ${post.mood != null ? `<span class="post-mood">${moodEmoji(post.mood)}</span>` : ""}
    </div>
    ${bodyHtml}
    ${quoteBlock}
    ${actions}
  </article>`;
}

// ---------- コンポーザー ----------

$("#composerText").addEventListener("input", () => {
  const len = $("#composerText").value.length;
  $("#charCount").textContent = len > 0 ? `${len}字` : "";
});

// Ctrl/Cmd+Enter で刻む
$("#composerText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitComposer();
  }
});

$("#postBtn").addEventListener("click", submitComposer);

function submitComposer() {
  const text = $("#composerText").value.trim();
  if (!text) return;
  const post = addPost({ text });
  $("#composerText").value = "";
  $("#charCount").textContent = "";
  justPosted.unshift({ id: post.id, echoIds: findEchoes(post, getPosts()).map((p) => p.id) });
  renderJustPosted();
}

// ---------- ホーム ----------
//
// 上から「いま書いたもの（＋こだま）」「今日の節目」「流れ」。
// 流れは開いたときに一度だけ組み、勝手に入れ替えない（無限に更新し続けるスロットにしない）。
// 1日の流量が DAILY_SOFT_LIMIT を超えたら「今日はここまで」の合図を出す。

const FLOW_BATCH = 15;
const FLOW_MORE = 10;
const NEW_SESSION_AFTER_MS = 30 * 60 * 1000; // これだけ離れて戻ってきたら流れを組み直す

let justPosted = [];      // [{ id, echoIds }] このセッションで書いた投稿
let anniversaryIds = [];  // 今日の節目
let flowIds = [];         // 流れてきた過去の自分
let flowExhausted = false;

function buildHome() {
  const posts = getPosts();
  const anniv = pickAnniversaries(posts);
  markSurfaced(anniv.map((p) => p.id));
  anniversaryIds = anniv.map((p) => p.id);
  const exclude = new Set([...anniversaryIds, ...justPosted.flatMap((j) => j.echoIds)]);
  const flow = pickFlow(posts, FLOW_BATCH, { exclude });
  flowIds = flow.map((p) => p.id);
  flowExhausted = flow.length < FLOW_BATCH;
  renderHome();
}

function moreFlow() {
  const exclude = new Set([...anniversaryIds, ...flowIds, ...justPosted.flatMap((j) => j.echoIds)]);
  const more = pickFlow(getPosts(), FLOW_MORE, { exclude });
  flowIds.push(...more.map((p) => p.id));
  flowExhausted = more.length < FLOW_MORE;
  renderFlow();
}

function renderHome() {
  renderJustPosted();
  renderAnniversary();
  renderFlow();
}

function renderJustPosted() {
  $("#homeJustPosted").innerHTML = justPosted.map(({ id, echoIds }) => {
    const post = getPost(id);
    if (!post) return "";
    const echoes = echoIds.map(getPost).filter(Boolean);
    const echoHtml = echoes.length ? `
      <div class="echo">
        <p class="echo-label">こだま — 似たことを書いていた過去のあなた</p>
        ${echoes.map((p) => postHtml(p, { variant: "past" })).join("")}
      </div>` : "";
    return postHtml(post, { variant: "now" }) + echoHtml;
  }).join("");
}

function renderAnniversary() {
  const posts = anniversaryIds.map(getPost).filter(Boolean);
  $("#homeAnniversary").innerHTML = posts.length
    ? `<p class="section-label">今日の節目</p>` +
      posts.map((p) => postHtml(p, { variant: "past", when: anniversaryLabel(p) })).join("")
    : "";
}

function renderFlow() {
  const all = getPosts();
  const posts = flowIds.map(getPost).filter(Boolean);

  if (all.length === 0) {
    $("#homeFlow").innerHTML = `<div class="feed-empty">ここに流れてくるのは、過去のあなただけ。<br>まずはひとつ刻もう。明日から、きょうの投稿が流れ始める。</div>`;
    return;
  }
  if (posts.length === 0) {
    $("#homeFlow").innerHTML = `<div class="feed-empty">まだ流れてくる過去がない。<br>1日以上前の投稿が、ここに流れてくる。</div>`;
    return;
  }

  const count = dailyCount();
  let end;
  if (flowExhausted) {
    end = `<div class="feed-end">いま流せる過去は、ここまで。</div>`;
  } else if (count >= DAILY_SOFT_LIMIT) {
    end = `<div class="feed-end">今日は ${count}件の過去と再会した。今日はここまで。
      <button class="link-btn" id="moreFlowBtn">それでも続ける</button></div>`;
  } else {
    end = `<div class="feed-end">ここまで流れた。
      <br><button class="btn" id="moreFlowBtn">もう少し流す</button></div>`;
  }

  $("#homeFlow").innerHTML = `<p class="section-label">流れてきた過去のあなた</p>` +
    posts.map((p) => postHtml(p, { variant: "past" })).join("") + end;
}

document.body.addEventListener("click", (e) => {
  if (e.target.closest("#moreFlowBtn")) moreFlow();
});

// しばらく離れて戻ってきたら、新しい流れを組む（X の「新しいポスト」に相当）
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > NEW_SESSION_AFTER_MS) {
    justPosted = [];
    buildHome();
  }
  hiddenAt = null;
});

// ---------- 記録（時系列の全投稿） ----------

// タイムライン全体は新しい順。ただし「連（スレッド）＝連続投稿の一息の塊」は、
// その内部だけ時系列順（古い→新しい＝上→下）に並べ替え、1つの .thread ブロックに
// まとめて描く。絞り込み・ページングの境界はこのセグメント単位で揃える（連の途中では切らない）。
function buildSegments(posts) {
  const segments = [];
  let i = 0;
  while (i < posts.length) {
    const p = posts[i];
    if (!p.threadId) { segments.push({ type: "single", post: p }); i++; continue; }
    let j = i;
    while (j + 1 < posts.length && posts[j + 1].threadId === p.threadId) j++;
    segments.push({ type: "thread", posts: posts.slice(i, j + 1) });
    i = j + 1;
  }
  return segments;
}

function segmentHtml(seg) {
  if (seg.type === "single") return postHtml(seg.post);
  // 連の内部は古い順に反転して、頭（起点）を上・続きを下にして並べる。
  const chrono = seg.posts.slice().reverse();
  const inner = [];
  chrono.forEach((post, k) => {
    inner.push(postHtml(post, { grouped: true, isCont: k > 0 }));
    if (k < chrono.length - 1) {
      // 直下の（一つ新しい）投稿との継ぎ目。切り離しは継続側（新しい方）で行う。
      const newer = chrono[k + 1];
      inner.push(`
      <div class="thread-seam">
        <button class="thread-cut-btn" data-action="cut-thread" data-id="${newer.id}" title="ここで連を切り離す" aria-label="ここで連を切り離す">✂️</button>
      </div>`);
    }
  });
  return `<div class="thread">${inner.join("")}</div>`;
}

const FEED_PAGE_SIZE = 100;
let feedFilter = { text: "", tag: null };
let feedVisibleCount = FEED_PAGE_SIZE;

function isFilterActive() {
  return Boolean(feedFilter.text || feedFilter.tag);
}

function matchesFilter(post) {
  const f = feedFilter;
  if (f.text && !post.text.toLowerCase().includes(f.text)) return false;
  if (f.tag && !(post.tags || []).includes(f.tag)) return false;
  return true;
}

function resetFeedPaging() {
  feedVisibleCount = FEED_PAGE_SIZE;
}

function topTags(posts, limit = 10) {
  const counts = new Map();
  posts.forEach((p) => (p.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function renderFilterBar(allPosts, filteredCount) {
  const tags = topTags(allPosts);
  $("#filterTagChips").innerHTML = tags.map(([t, c]) =>
    `<button class="tag-chip${feedFilter.tag === t ? " active" : ""}" data-tag-filter="${escapeHtml(t)}">#${escapeHtml(t)} <span class="tag-count">${c}</span></button>`
  ).join("");

  const active = isFilterActive();
  $("#filterClearBtn").hidden = !active;
  const countEl = $("#filterCount");
  countEl.hidden = !active;
  if (active) countEl.textContent = `${filteredCount}件が一致`;
}

function clearFilter() {
  feedFilter = { text: "", tag: null };
  $("#filterText").value = "";
  resetFeedPaging();
}

$("#filterText").addEventListener("input", (e) => {
  feedFilter.text = e.target.value.trim().toLowerCase();
  resetFeedPaging();
  renderFeed();
});
$("#filterTagChips").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tag-filter]");
  if (!btn) return;
  const t = btn.dataset.tagFilter;
  feedFilter.tag = feedFilter.tag === t ? null : t;
  resetFeedPaging();
  renderFeed();
});
$("#filterClearBtn").addEventListener("click", () => {
  clearFilter();
  renderFeed();
});

// 本文中のタグ（#foo）をクリックすると、そのタグで記録を絞り込む
document.body.addEventListener("click", (e) => {
  const tagSpan = e.target.closest(".tag[data-tag]");
  if (!tagSpan) return;
  const t = tagSpan.dataset.tag;
  feedFilter.tag = feedFilter.tag === t ? null : t;
  resetFeedPaging();
  switchView("log");
});

// もっと読む（ページング。連の途中では切らない）
document.body.addEventListener("click", (e) => {
  const btn = e.target.closest("#loadMoreBtn");
  if (!btn) return;
  feedVisibleCount += FEED_PAGE_SIZE;
  renderFeed();
});

function renderFeed() {
  const allPosts = getPosts();
  const active = isFilterActive();
  const posts = active ? allPosts.filter(matchesFilter) : allPosts;
  renderFilterBar(allPosts, posts.length);

  if (allPosts.length === 0) {
    $("#feed").innerHTML = `<div class="feed-empty">まだ何もない。ホームで最初のひとつを刻もう。</div>`;
    return;
  }
  if (posts.length === 0) {
    $("#feed").innerHTML = `<div class="feed-empty">条件に一致する記録はありません。</div>`;
    return;
  }

  const segments = buildSegments(posts);

  // ページング境界を連（threadId）のまとまりに合わせて揃える。
  let count = 0;
  let cut = segments.length;
  for (let s = 0; s < segments.length; s++) {
    if (count >= feedVisibleCount) { cut = s; break; }
    count += segments[s].type === "thread" ? segments[s].posts.length : 1;
  }
  const visible = segments.slice(0, cut);
  const hasMore = cut < segments.length;

  const parts = visible.map(segmentHtml);
  if (hasMore) parts.push(`<button class="btn load-more-btn" id="loadMoreBtn">もっと読む</button>`);
  $("#feed").innerHTML = parts.join("");
}

// 連（スレッド）を手動で切り離す
document.body.addEventListener("click", (e) => {
  const btn = e.target.closest(".thread-cut-btn");
  if (!btn) return;
  breakThreadLink(btn.dataset.id);
  renderFeed();
});

// 記録タブでその投稿の位置へジャンプする（絞り込みを外し、ページングを必要なだけ広げる）
function viewPostInTimeline(postId) {
  $("#quoteModal").hidden = true;
  clearFilter();
  const idx = getPosts().findIndex((p) => p.id === postId);
  if (idx >= feedVisibleCount) feedVisibleCount = Math.ceil((idx + 1) / FEED_PAGE_SIZE) * FEED_PAGE_SIZE;
  switchView("log");
  requestAnimationFrame(() => {
    const el = document.querySelector(`#feed .post[data-id="${postId}"]`);
    if (!el) return;
    const container = el.closest(".thread") || el;
    container.scrollIntoView({ behavior: "smooth", block: "center" });
    container.classList.add("thread-highlight");
    setTimeout(() => container.classList.remove("thread-highlight"), 2000);
  });
}

// ---------- ポストへのアクション（イベント委譲） ----------

function rerenderPosts() {
  renderHome();
  if (!$("#view-log").hidden) renderFeed();
}

document.body.addEventListener("click", (e) => {
  const btn = e.target.closest(".pa-btn");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const post = getPost(id);
  if (!post) return;

  if (action === "repost") {
    const repost = addPost({ text: "", type: "repost", refId: post.id });
    justPosted.unshift({ id: repost.id, echoIds: [] });
    rerenderPosts();
  }

  if (action === "quote") openQuoteModal(post);

  if (action === "context") viewPostInTimeline(post.id);

  if (action === "mute") {
    mute(post.id);
    flowIds = flowIds.filter((x) => x !== post.id);
    anniversaryIds = anniversaryIds.filter((x) => x !== post.id);
    justPosted.forEach((j) => { j.echoIds = j.echoIds.filter((x) => x !== post.id); });
    renderHome();
  }

  if (action === "delete") {
    if (confirm("このポストを削除しますか？")) {
      deletePost(id);
      justPosted = justPosted.filter((j) => j.id !== id);
      rerenderPosts();
    }
  }
});

// ---------- 引用モーダル（接ぎ木） ----------

let quoteTargetId = null;

function openQuoteModal(post) {
  quoteTargetId = post.id;
  $("#quoteTarget").innerHTML = `<span class="q-meta">${fmtDateTime(post.createdAt)}（${fmtAgo(post.createdAt)}）</span>${renderBody(post.text)}`;
  $("#quoteText").value = "";
  $("#quoteModal").hidden = false;
  $("#quoteText").focus();
}

$("#quoteCancelBtn").addEventListener("click", () => { $("#quoteModal").hidden = true; });
$("#quoteModal").addEventListener("click", (e) => {
  if (e.target === $("#quoteModal")) $("#quoteModal").hidden = true;
});
$("#quoteSubmitBtn").addEventListener("click", () => {
  const text = $("#quoteText").value.trim();
  if (!text || !quoteTargetId) return;
  const quote = addPost({ text, type: "quote", refId: quoteTargetId });
  $("#quoteModal").hidden = true;
  justPosted.unshift({ id: quote.id, echoIds: [] });
  switchView("home");
  rerenderPosts();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("#quoteViewThreadBtn").addEventListener("click", () => {
  if (quoteTargetId) viewPostInTimeline(quoteTargetId);
});

// ---------- 設定：流れ ----------

function renderFlowSettings() {
  const n = mutedCount();
  $("#mutedInfo").textContent = n > 0 ? `「もう流さない」にした投稿: ${n}件` : "「もう流さない」にした投稿はありません。";
  $("#unmuteAllBtn").hidden = n === 0;
}

$("#unmuteAllBtn").addEventListener("click", () => {
  unmuteAll();
  renderFlowSettings();
});

// ---------- 設定：データ ----------

function backupFileName() {
  return `cns-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

function showDataMsg(text) {
  $("#dataActionMsg").textContent = text;
  setTimeout(() => { $("#dataActionMsg").textContent = ""; }, 2500);
}

function doImport(text) {
  if (!confirm("現在のデータをインポート内容で置き換えます。よろしいですか？")) return;
  importJson(text);
  resetSurface();
  justPosted = [];
  buildHome();
  renderAll();
  alert("インポートしました");
}

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([exportJson()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = backupFileName();
  a.click();
  URL.revokeObjectURL(a.href);
});

if (navigator.share && navigator.canShare) {
  const testFile = new File(["{}"], "test.json", { type: "application/json" });
  if (navigator.canShare({ files: [testFile] })) {
    $("#shareExportBtn").hidden = false;
  }
}

$("#shareExportBtn").addEventListener("click", async () => {
  const file = new File([exportJson()], backupFileName(), { type: "application/json" });
  try {
    await navigator.share({ files: [file], title: "MEMO バックアップ" });
  } catch (err) {
    if (err.name !== "AbortError") alert(`共有に失敗しました: ${err.message}`);
  }
});

$("#copyExportBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(exportJson());
    showDataMsg("クリップボードにコピーしました");
  } catch (err) {
    alert(`コピーに失敗しました: ${err.message}`);
  }
});

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    doImport(text);
  } catch (err) {
    alert(`インポート失敗: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

$("#importPasteBtn").addEventListener("click", () => {
  const text = $("#importPasteArea").value.trim();
  if (!text) { alert("JSONを貼り付けてください"); return; }
  try {
    doImport(text);
    $("#importPasteArea").value = "";
  } catch (err) {
    alert(`インポート失敗: ${err.message}`);
  }
});

$("#wipeBtn").addEventListener("click", () => {
  if (!confirm("本当にすべての投稿を削除しますか？この操作は取り消せません。")) return;
  if (!confirm("最終確認：流れてくる過去の自分もいなくなります。削除しますか？")) return;
  wipeAll();
  resetSurface();
  justPosted = [];
  buildHome();
  renderAll();
});

// ---------- クラウド同期 ----------

function fmtClock(d) {
  if (!d) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderSyncUI() {
  const st = getSyncState();

  // 接続先が未設定なら「接続先の設定」を開いておく
  $("#syncConfigDetails").open = !st.configured;

  // ログインフォーム／同期状態の出し分け
  $("#syncAuthBox").hidden = !st.configured || st.loggedIn;
  $("#syncStatusBox").hidden = !st.loggedIn;

  if (st.loggedIn) {
    $("#syncAutoToggle").checked = st.autoSync;
    const dot = $("#syncDot");
    let text;
    if (st.syncing) {
      dot.className = "sync-dot syncing";
      text = `同期中…（${st.email}）`;
    } else if (st.lastError) {
      dot.className = "sync-dot error";
      text = `${st.email}｜エラー: ${st.lastError}`;
    } else {
      dot.className = "sync-dot ok";
      text = st.lastSyncAt
        ? `${st.email}｜最終同期 ${fmtClock(st.lastSyncAt)}`
        : `${st.email}｜ログイン済み`;
    }
    $("#syncStatusText").textContent = text;
    $("#syncNote").textContent = "※ 削除も同期されます。反映にはもう一方の端末を開く（または少し待つ）必要があります。";
  }
}

$("#syncConfigSaveBtn").addEventListener("click", () => {
  const url = $("#syncUrlInput").value.trim();
  const anonKey = $("#syncAnonInput").value.trim();
  if (!url || !anonKey) { $("#syncConfigMsg").textContent = "URLと公開キーを入力してください"; return; }
  saveSyncConfig({ url, anonKey });
  $("#syncConfigMsg").textContent = "保存しました";
  setTimeout(() => { $("#syncConfigMsg").textContent = ""; }, 2000);
  renderSyncUI();
});

async function doAuth(kind) {
  const email = $("#syncEmailInput").value.trim();
  const password = $("#syncPasswordInput").value;
  if (!email || !password) { $("#syncAuthMsg").textContent = "メールとパスワードを入力してください"; return; }
  $("#syncAuthMsg").textContent = kind === "login" ? "ログイン中…" : "登録中…";
  try {
    if (kind === "signup") {
      const { needsConfirmation } = await signUp(email, password);
      if (needsConfirmation) {
        $("#syncAuthMsg").textContent = "確認メールを送信しました。メール内のリンクを開いた後、ログインしてください。";
        return;
      }
    } else {
      await signIn(email, password);
    }
    $("#syncPasswordInput").value = "";
    $("#syncAuthMsg").textContent = "";
    renderSyncUI();
    const st = await syncNow();
    renderAll();
    if (st.lastError) $("#syncAuthMsg").textContent = `同期エラー: ${st.lastError}`;
  } catch (err) {
    $("#syncAuthMsg").textContent = `失敗: ${err.message}`;
  }
}

$("#syncLoginBtn").addEventListener("click", () => doAuth("login"));
$("#syncSignupBtn").addEventListener("click", () => doAuth("signup"));

$("#syncLogoutBtn").addEventListener("click", async () => {
  await signOut();
  renderSyncUI();
});

$("#syncNowBtn").addEventListener("click", async () => {
  const btn = $("#syncNowBtn");
  btn.disabled = true;
  renderSyncUI();
  const st = await syncNow();
  renderAll();
  btn.disabled = false;
  if (st.lastError) alert(`同期エラー: ${st.lastError}`);
});

$("#syncAutoToggle").addEventListener("change", (e) => {
  setAutoSync(e.target.checked);
  if (e.target.checked) scheduleAutoPush();
});

// データ変更のたびに自動プッシュ（デバウンス）
onMutation(() => scheduleAutoPush());

// ---------- 初期化 ----------

// 同期やインポートで中身が入れ替わったときの再描画。流れは組み直さない（読んでいる最中に入れ替えない）。
function renderAll() {
  renderHome();
  renderFeed();
  renderFlowSettings();
  renderSyncUI();
}

buildHome();
renderAll();

// クラウド同期の起動（設定済みかつログイン済みなら初回同期）
// 初回同期で他端末の投稿が入ってきたら、まだ流れが空のときだけ組み直す。
initSync({
  onApplied: () => {
    if (flowIds.length === 0 && anniversaryIds.length === 0) buildHome();
    renderAll();
  },
});

// ---------- Service Worker登録（オフライン起動用。失敗しても致命的ではないので無視する） ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
