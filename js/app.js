import {
  MOODS,
  getPosts, getPost, getSettings, saveSettings,
  addPost, deletePost, setAiReply,
  breakThreadLink,
  getReports, deleteReport, setReportFeedback,
  activeDays, daysSinceFirstPost,
  exportJson, importJson, wipeAll,
  onMutation,
} from "./store.js";
import {
  initSync, getSyncState, saveConfig as saveSyncConfig,
  signIn, signUp, signOut, syncNow, setAutoSync, scheduleAutoPush,
} from "./sync.js";
import { milestoneBonus, pickForTicker, ageInDays } from "./mass.js";
import { stageOf, nextStage, isSprouted, bunchCount, renderVineSvg } from "./vine.js";
import { PROVIDERS, replyToPost, postsInLastDays, hasApiKey, localAnalysis, currentModelLabel } from "./ai.js";
import { listGeneratablePeriods, pendingWeekly, generateReport, reportTimeSeries, themeLifecycles, recurringBlindSpots, suggestionFollowThrough, selfReportedMoodByPeriod } from "./report.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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

function moodEmoji(mood) {
  return MOODS.find((m) => m.value === mood)?.emoji || "";
}

// ---------- タブ切り替え ----------

const views = ["timeline", "timeaxis", "vine", "report", "settings"];

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
  if (name === "timeaxis") renderTimeaxis();
  if (name === "vine") renderVine();
  if (name === "report") renderReportView();
}

// ---------- コンポーザー ----------

let selectedMood = null;

function renderMoodPicker() {
  $("#moodPicker").innerHTML = MOODS.map(
    (m) => `<button class="mood-btn ${m.value === selectedMood ? "active" : ""}" data-mood="${m.value}">${m.emoji}</button>`
  ).join("");
}
$("#moodPicker").addEventListener("click", (e) => {
  const btn = e.target.closest(".mood-btn");
  if (!btn) return;
  const v = Number(btn.dataset.mood);
  selectedMood = selectedMood === v ? null : v; // 同じものを押すと解除
  renderMoodPicker();
});

$("#composerText").addEventListener("input", () => {
  const len = $("#composerText").value.length;
  $("#charCount").textContent = len > 0 ? `${len}字` : "";
});

$("#composerText").addEventListener("focus", updateThreadHint);

// 連（スレッド）: 直前の投稿から閾値分以内なら「続き」になる。自動が既定だが、
// 別の話題を書き始めるときは手で切れるようにする（判断コストは基本ゼロ）。
let breakNextThread = false;

function updateThreadHint() {
  const hint = $("#threadHint");
  const latest = getPosts()[0];
  const windowMin = getSettings().threadWindowMin ?? 5;
  const within = latest && latest.type === "post" &&
    (Date.now() - new Date(latest.createdAt).getTime()) / 60000 <= windowMin;
  if (!within) { hint.hidden = true; breakNextThread = false; return; }
  hint.hidden = false;
  $("#threadHintIcon").textContent = breakNextThread ? "🌿" : "↳";
  $("#threadHintText").textContent = breakNextThread ? "新しい連として始めます" : "さっきの続きになります";
  $$("#threadToggle .thread-toggle-btn").forEach((b) => {
    b.classList.toggle("active", (b.dataset.mode === "break") === breakNextThread);
  });
}

$("#threadToggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".thread-toggle-btn");
  if (!btn) return;
  breakNextThread = btn.dataset.mode === "break";
  updateThreadHint();
});

$("#postBtn").addEventListener("click", () => {
  const text = $("#composerText").value.trim();
  if (!text) return;
  const post = addPost({ text, mood: selectedMood, standalone: breakNextThread });
  $("#composerText").value = "";
  $("#charCount").textContent = "";
  selectedMood = null;
  breakNextThread = false;
  renderMoodPicker();
  renderFeed();
  updateThreadHint();
  updateVineBadge();
  updateTicker();
  maybeAutoReply(post);
});

// AIの自動返信（設定でONのとき、たまに返ってくる）
async function maybeAutoReply(post) {
  const { aiAutoReply } = getSettings();
  if (!aiAutoReply || !hasApiKey()) return;
  if (Math.random() > 0.4) return; // 毎回ではなく「ときどき」
  try {
    const reply = await replyToPost(post, getPosts());
    setAiReply(post.id, reply);
    renderFeed();
  } catch { /* 静かに失敗 */ }
}

// ---------- フィード ----------

function postHtml(post, { showActions = true, grouped = false, isCont = false } = {}) {
  const ref = post.refId ? getPost(post.refId) : null;

  let repostNote = "";
  let quoteBlock = "";
  if (post.type === "repost" && ref) {
    repostNote = `<div class="repost-note">🔁 過去の自分を再掲（再芽）</div>`;
  }
  if (ref && (post.type === "quote" || post.type === "repost")) {
    quoteBlock = `<blockquote><span class="q-meta">${fmtDateTime(ref.createdAt)}（${fmtAgo(ref.createdAt)}）</span>${renderBody(ref.text)}</blockquote>`;
  } else if (post.refId && !ref) {
    quoteBlock = `<blockquote><span class="q-meta">（削除されたポスト）</span></blockquote>`;
  }

  const bodyHtml = post.text ? `<div class="post-body">${renderBody(post.text)}</div>` : "";
  const aiReplyHtml = post.aiReply
    ? `<div class="ai-reply"><span class="ai-icon">🤖</span><span>${renderBody(post.aiReply.text)}</span></div>`
    : "";

  const actions = showActions ? `
    <div class="post-actions">
      <button class="pa-btn" data-action="repost" data-id="${post.id}" title="再掲する">🔁 再芽</button>
      <button class="pa-btn" data-action="quote" data-id="${post.id}" title="引用する">🌿 接ぎ木 ${post.quoteCount ? post.quoteCount : ""}</button>
      <button class="pa-btn" data-action="ai" data-id="${post.id}" title="AIに返信をもらう">🤖 AIの目</button>
      <button class="pa-btn danger" data-action="delete" data-id="${post.id}">削除</button>
    </div>` : "";

  // 連（スレッド）の一員として描くときは grouped=true。枠・角丸・余白を外し、
  // 親の .thread ブロックに密着させて「1つのまとまり」に見せる。
  // isCont（連の先頭＝最古以外）には控えめな「↳」で続きを示す。
  const threadClass = grouped ? " thread-item" : "";
  const threadMark = isCont ? `<span class="thread-mark" title="さっきの続き（同じ一息）">↳</span>` : "";

  return `
  <article class="post${threadClass}" data-id="${post.id}">
    ${repostNote}
    <div class="post-head">
      ${threadMark}
      <span>${fmtDateTime(post.createdAt)}</span>
      <span>${fmtAgo(post.createdAt)}</span>
      ${post.mood != null ? `<span class="post-mood">${moodEmoji(post.mood)}</span>` : ""}
    </div>
    ${bodyHtml}
    ${quoteBlock}
    ${aiReplyHtml}
    ${actions}
  </article>`;
}

// タイムライン全体は新しい順。ただし「連（スレッド）＝連続投稿の一息の塊」は、
// その内部だけ時系列順（古い→新しい＝上→下）に並べ替え、1つの .thread ブロックに
// まとめて描く。連は書いた順に上から読めるようにし、連と連の間は従来どおり新しい順
// を保つ（＝下に行くほど過去）。posts（新しい順）を「単独ポスト」または「連のまとまり」
// のセグメント列に分ける。絞り込み・ページングの境界はこのセグメント単位で揃える
// （連の途中では切らない）。
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

// ---------- 絞り込み（検索・タグ・気分・期間） ----------

const FEED_PAGE_SIZE = 100;
let feedFilter = { text: "", moods: new Set(), from: "", to: "", tag: null };
let feedVisibleCount = FEED_PAGE_SIZE;

function isFilterActive() {
  return Boolean(feedFilter.text || feedFilter.moods.size > 0 || feedFilter.from || feedFilter.to || feedFilter.tag);
}

function matchesFilter(post) {
  const f = feedFilter;
  if (f.text && !post.text.toLowerCase().includes(f.text)) return false;
  if (f.moods.size > 0 && !(post.mood != null && f.moods.has(post.mood))) return false;
  const day = post.createdAt.slice(0, 10);
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;
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
  $("#filterMoodPicker").innerHTML = MOODS.map(
    (m) => `<button class="mood-btn ${feedFilter.moods.has(m.value) ? "active" : ""}" data-filter-mood="${m.value}">${m.emoji}</button>`
  ).join("");

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

$("#filterText").addEventListener("input", (e) => {
  feedFilter.text = e.target.value.trim().toLowerCase();
  resetFeedPaging();
  renderFeed();
});
$("#filterFrom").addEventListener("change", (e) => {
  feedFilter.from = e.target.value;
  resetFeedPaging();
  renderFeed();
});
$("#filterTo").addEventListener("change", (e) => {
  feedFilter.to = e.target.value;
  resetFeedPaging();
  renderFeed();
});
$("#filterMoodPicker").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-filter-mood]");
  if (!btn) return;
  const v = Number(btn.dataset.filterMood);
  if (feedFilter.moods.has(v)) feedFilter.moods.delete(v); else feedFilter.moods.add(v);
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
  feedFilter = { text: "", moods: new Set(), from: "", to: "", tag: null };
  $("#filterText").value = "";
  $("#filterFrom").value = "";
  $("#filterTo").value = "";
  resetFeedPaging();
  renderFeed();
});

// 本文中のタグ（#foo）をクリックすると、そのタグでタイムラインを絞り込む
document.body.addEventListener("click", (e) => {
  const tagSpan = e.target.closest(".tag[data-tag]");
  if (!tagSpan) return;
  const t = tagSpan.dataset.tag;
  feedFilter.tag = feedFilter.tag === t ? null : t;
  resetFeedPaging();
  switchView("timeline");
  renderFeed();
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
    $("#feed").innerHTML = `<div class="feed-empty">まだ何もない。ここはあなたと、やがて芽吹く過去のあなただけの場所。<br>最初のひと粒を刻もう。</div>`;
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

// フィード内アクション（イベント委譲）
document.body.addEventListener("click", async (e) => {
  const btn = e.target.closest(".pa-btn");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const post = getPost(id);
  if (!post) return;

  if (action === "repost") {
    addPost({ text: "", type: "repost", refId: post.id });
    renderFeed();
    updateVineBadge();
  }

  if (action === "quote") {
    openQuoteModal(post);
  }

  if (action === "delete") {
    if (confirm("このポストを削除しますか？")) {
      deletePost(id);
      renderFeed();
      updateTicker();
    }
  }

  if (action === "ai") {
    if (!hasApiKey()) {
      alert("設定タブでAPIキーを登録すると、AIが返信してくれます。");
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spin">🤖</span> 考え中…`;
    try {
      const reply = await replyToPost(post, getPosts());
      setAiReply(post.id, reply);
      renderFeed();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "🤖 AIの目";
    }
  }
});

// ---------- 引用モーダル ----------

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
  addPost({ text, type: "quote", refId: quoteTargetId });
  $("#quoteModal").hidden = true;
  renderFeed();
  updateVineBadge();
  updateTicker();
});

// 引用対象がどの連（スレッド）にいたかをタイムラインで確認できるようにする
$("#quoteViewThreadBtn").addEventListener("click", () => {
  if (quoteTargetId) viewPostInTimeline(quoteTargetId);
});

function viewPostInTimeline(postId) {
  $("#quoteModal").hidden = true;
  switchView("timeline");
  requestAnimationFrame(() => {
    const el = document.querySelector(`.post[data-id="${postId}"]`);
    if (!el) return;
    const container = el.closest(".thread") || el;
    container.scrollIntoView({ behavior: "smooth", block: "center" });
    container.classList.add("thread-highlight");
    setTimeout(() => container.classList.remove("thread-highlight"), 2000);
  });
}

// ---------- 電光掲示板（ティッカー） ----------

// 現在流れている内容（投稿id）。すでに表示中なら、投稿・削除・引用の
// たびに巻き戻して作り直したりしない（＝流れきる前に消える不具合の原因だった）。
// 中身の入れ替えは、再表示のタイミングか forceRefresh 時だけ行う。
let tickerRenderedIds = null;

function updateTicker(forceRefresh = false) {
  const days = activeDays();
  const sprouted = isSprouted(days);
  const posts = getPosts();

  if (!sprouted) {
    $("#tickerWrap").hidden = true;
    tickerRenderedIds = null;
    if (posts.length > 0) {
      $("#tickerLocked").hidden = false;
      $("#tickerLockedMsg").textContent = `あと${7 - days}日活動すると発芽し、過去の自分がここに流れ始めます（現在 ${days}/7日）`;
    } else {
      $("#tickerLocked").hidden = true;
    }
    return;
  }

  const alreadyShowing = !$("#tickerWrap").hidden && tickerRenderedIds;
  if (alreadyShowing && !forceRefresh) return;

  const picked = pickForTicker(posts, 12);
  if (picked.length === 0) {
    $("#tickerWrap").hidden = true;
    $("#tickerLocked").hidden = false;
    $("#tickerLockedMsg").textContent = "発芽しました。3日以上前のポストが増えると、ここに過去の自分が流れます。";
    tickerRenderedIds = null;
    return;
  }

  $("#tickerLocked").hidden = true;
  $("#tickerWrap").hidden = false;
  tickerRenderedIds = picked.map((p) => p.id);

  const itemsHtml = picked.map((p) => {
    const { label } = milestoneBonus(p);
    const when = label || fmtAgo(p.createdAt);
    const text = p.text.length > 60 ? p.text.slice(0, 60) + "…" : p.text;
    return `<span class="ticker-item" data-id="${p.id}"><span class="t-when">${when}の自分</span>${escapeHtml(text)}</span>`;
  }).join("");

  // シームレスにループさせるため2周分並べる
  const track = $("#tickerTrack");
  track.innerHTML = itemsHtml + itemsHtml;
  // 速度は件数ではなく実際の描画幅から一定に保つ（文字数次第で速度がバラつき、
  // 読み切る前に消えたように見えるのを防ぐ）
  const PX_PER_SEC = 55;
  const distance = track.scrollWidth / 2;
  const dur = Math.max(20, distance / PX_PER_SEC);
  track.style.animationDuration = `${dur}s`;
}

// しばらく経ったら中身を入れ替える（流れている最中には割り込まない）
setInterval(() => updateTicker(true), 90000);

// ティッカーのポストをクリック → 引用モーダル（過去の自分に接ぎ木する）
$("#tickerTrack").addEventListener("click", (e) => {
  const item = e.target.closest(".ticker-item");
  if (!item) return;
  const post = getPost(item.dataset.id);
  if (post) openQuoteModal(post);
});

// ---------- レポート未作成バナー ----------

function updatePendingBanner() {
  const pending = pendingWeekly();
  if (!pending) {
    $("#pendingBanner").hidden = true;
    return;
  }
  $("#pendingBanner").hidden = false;
  $("#pendingBannerMsg").textContent = `${pending.label}のレポートが作成できます（雑記${pending.count}件）`;
}
$("#pendingBannerGo").addEventListener("click", () => switchView("report"));

// ---------- 時間軸ビュー ----------

const AXES = [
  { label: "1週間前", days: 7, window: 1 },
  { label: "1ヶ月前", days: 30, window: 3 },
  { label: "3ヶ月前", days: 90, window: 5 },
  { label: "1年前", days: 365, window: 7 },
  { label: "5年前", days: 365 * 5, window: 14 },
  { label: "10年前", days: 365 * 10, window: 21 },
];

function renderTimeaxis() {
  const posts = getPosts();
  const now = Date.now();
  const sections = AXES.map(({ label, days, window: win }) => {
    const target = new Date(now - days * 86400000);
    const hits = posts.filter((p) => Math.abs(ageInDays(p, now) - days) <= win);
    const dateStr = `${target.getFullYear()}/${target.getMonth() + 1}/${target.getDate()} 前後`;
    const body = hits.length
      ? hits.map((p) => postHtml(p)).join("")
      : `<p class="axis-empty">この頃の記録はまだない。${days > daysSinceFirstPost() ? "未来のあなたがこの欄を埋める。" : ""}</p>`;
    return `<div class="axis-section"><h3>${label}の自分 <span class="axis-date">${dateStr}</span></h3>${body}</div>`;
  });
  $("#timeaxisBody").innerHTML = sections.join("");
}

// ---------- ブドウの木ビュー ----------

function renderVine() {
  const days = activeDays();
  const posts = getPosts();
  const stage = stageOf(days);
  const next = nextStage(days);
  const bunches = bunchCount(posts);

  $("#vineSvgWrap").innerHTML = renderVineSvg(days, posts.length, bunches);

  let progressHtml = "";
  if (next) {
    const prev = stage.minDays;
    const pct = Math.min(100, Math.round(((days - prev) / (next.minDays - prev)) * 100));
    progressHtml = `
      <div class="vine-progress-bar"><div class="vine-progress-fill" style="width:${pct}%"></div></div>
      <div class="muted">次の段階「${next.emoji} ${next.name}」まで、あと${next.minDays - days}日の活動</div>`;
  } else {
    progressHtml = `<div class="muted">木は成熟しました。それでも、刻むたびに房は増えていく。</div>`;
  }

  $("#vineInfo").innerHTML = `
    <div class="vine-stage-name">${stage.emoji} ${stage.name} — ${stage.desc}</div>
    ${progressHtml}
    <div class="vine-stats">
      <span>活動日数 <b>${days}日</b></span>
      <span>ポスト <b>${posts.length}件</b></span>
      <span>房（引用された記録） <b>${bunches}</b></span>
      <span>初日から <b>${daysSinceFirstPost()}日</b></span>
    </div>`;
}

function updateVineBadge() {
  const stage = stageOf(activeDays());
  $("#vineBadge").textContent = `${stage.emoji} ${stage.name} / ${activeDays()}日`;
}

// ---------- レポートビュー ----------

const PERIOD_TYPE_LABEL = { weekly: "📅 週次", monthly: "🗓 月次", quarterly: "📆 四半期", yearly: "🌍 年次" };
const ROLLUP_PERIOD_TYPES = ["quarterly", "yearly"];

function renderReportView() {
  renderPeriodSelect();
  renderMetaAnalysis();
  renderMoodGap();
  renderReportList();
  renderMoodChart();
  renderLocalStats();
}

function renderPeriodSelect() {
  const periods = listGeneratablePeriods();
  const sel = $("#periodSelect");
  if (periods.length === 0) {
    sel.innerHTML = `<option value="">作成できる期間がありません</option>`;
    sel.disabled = true;
    $("#generateReportBtn").disabled = true;
    $("#generateHint").textContent = getPosts().length === 0
      ? "まず雑記を刻んでください。週が完了するとレポートを作成できます。"
      : "直近の完了した週・月のレポートはすべて作成済みか、対象の雑記がありません。今週が終わると次のレポートが作れます。";
    return;
  }
  sel.disabled = false;
  $("#generateReportBtn").disabled = false;
  sel.innerHTML = periods.map((p, i) =>
    `<option value="${i}">${PERIOD_TYPE_LABEL[p.type] || p.type} ${p.label}（${p.count}件）</option>`
  ).join("");
  $("#generateHint").textContent = hasApiKey()
    ? `使用モデル: ${currentModelLabel()}`
    : "APIキー未設定です。設定タブでClaudeまたはGeminiのキーを登録してください。";
  window.__generatablePeriods = periods;
}

$("#generateReportBtn").addEventListener("click", async () => {
  const periods = window.__generatablePeriods || [];
  const idx = Number($("#periodSelect").value);
  const period = periods[idx];
  if (!period) return;
  if (!hasApiKey()) {
    alert("設定タブでAPIキーを登録してください（レポート生成にはAIが必要です）。");
    return;
  }
  const btn = $("#generateReportBtn");
  btn.disabled = true;
  $("#generateStatus").innerHTML = `<span class="spin">🍇</span> 他者があなたの${period.label}を読んでいます…`;
  const onProgress = ({ stage, done, total }) => {
    const label = stage === "extract"
      ? "無造作な雑記を観測ユニットに分解中"
      : "観測を統合し、構造データと手紙を書いています";
    const counter = total > 1 ? `（${done}/${total}）` : "";
    $("#generateStatus").innerHTML = `<span class="spin">🍇</span> ${label}…${counter}`;
  };
  try {
    await generateReport(period, { onProgress });
    $("#generateStatus").textContent = "";
    renderReportView();
    updatePendingBanner();
  } catch (err) {
    $("#generateStatus").textContent = `エラー: ${err.message}`;
    btn.disabled = false;
  }
});

const TREND_LABEL = { up: "↗ 上向き", flat: "→ 安定", down: "↘ 下向き" };

// レポートの生成来歴（多段パイプラインの実績）を短く添える
function pipelineNote(p) {
  if (!p) return "";
  if (p.mode === "map-reduce") return ` / 多段解析（${p.chunks}分割→${p.units}観測ユニット, API${p.requests}回）`;
  if (p.mode === "rollup-map-reduce") return ` / ロールアップ多段解析（${p.chunks}グループ→${p.units}件のレポートを統合, API${p.requests}回）`;
  if (p.mode === "rollup-single") return ` / ロールアップ一括解析（${p.units}件のレポートを統合）`;
  return " / 一括解析";
}

// 前回の一手の追跡（schemaVersion 2 以降）。開ループが閉じたかを、手紙と同じ見える階層に出す。
const ACTION_REVIEW = {
  done:     { icon: "✅", label: "前回の一手: 実行できていた", cls: "fu-done" },
  partial:  { icon: "🔸", label: "前回の一手: 部分的に実行",   cls: "fu-partial" },
  not_done: { icon: "⭕️", label: "前回の一手: 手つかず",       cls: "fu-notdone" },
  unknown:  { icon: "—",  label: "前回の一手: 判定できず",     cls: "fu-unknown" },
};

function followUpHtml(r) {
  if ((r.schemaVersion || 1) < 2) return ""; // v1レポートはこのフィールドを持たない
  const pr = r.data.previous_action_review;
  if (!pr) return "";
  const meta = ACTION_REVIEW[pr.status] || ACTION_REVIEW.unknown;
  // 追跡対象が無かった期間（前回レポート無し）で、根拠も無いなら黙って出さない
  if (pr.status === "unknown" && !pr.evidence) return "";
  return `
    <div class="report-followup">
      <span class="fu-badge ${meta.cls}">${meta.icon} ${meta.label}</span>
      ${pr.evidence ? `<span class="fu-evidence">${escapeHtml(pr.evidence)}</span>` : ""}
    </div>`;
}

function openLoopsHtml(r) {
  if ((r.schemaVersion || 1) < 2) return "";
  const loops = Array.isArray(r.data.open_loops) ? r.data.open_loops : [];
  if (loops.length === 0) return "";
  const items = loops.map((o) =>
    `<li><span class="loop-label">${escapeHtml(o.label)}</span>${o.note ? `<span class="loop-note">${escapeHtml(o.note)}</span>` : ""}</li>`
  ).join("");
  return `
    <div class="report-loops">
      <div class="loops-head">🔁 持ち越している宿題</div>
      <ul class="loops-list">${items}</ul>
    </div>`;
}

const VERDICT_META = {
  agree: { icon: "🙆", label: "納得する" },
  disagree: { icon: "🙅", label: "反論する" },
  hold: { icon: "🤔", label: "保留" },
};

// 盲点への応答UI。「AIの断定を鵜呑みにしない装置」なので3択は等価に扱い、
// 反論を目立たない扱いにしない。応答済みならその内容も表示する。
function blindSpotHtml(r) {
  const d = r.data;
  const blindSpot = String(d.blind_spot || "").trim();
  if (!blindSpot) return "";
  const fb = r.feedback?.blindSpot;
  const buttons = ["agree", "disagree", "hold"].map((v) => {
    const m = VERDICT_META[v];
    const active = fb?.verdict === v ? " active" : "";
    return `<button class="fb-btn fb-${v}${active}" data-fb-verdict="${v}">${m.icon} ${m.label}</button>`;
  }).join("");
  const existing = fb
    ? `<p class="fb-existing">応答: <b>${VERDICT_META[fb.verdict]?.label || fb.verdict}</b>${fb.note ? `「${escapeHtml(fb.note)}」` : ""}<span class="muted"> ${fmtDateTime(fb.at)}</span></p>`
    : "";
  return `
    <div class="report-blindspot">
      <h4>盲点</h4><p>${escapeHtml(blindSpot)}</p>
      ${d.contradiction ? `<h4>矛盾・ズレ</h4><p>${escapeHtml(d.contradiction)}</p>` : ""}
      <div class="blindspot-feedback" data-feedback-report="${r.id}">
        <div class="fb-buttons">${buttons}</div>
        <textarea class="fb-note" rows="1" placeholder="一言（任意）">${escapeHtml(fb?.note || "")}</textarea>
        ${existing}
      </div>
    </div>`;
}

function reportCardHtml(r) {
  const d = r.data;
  const themes = (d.themes || []).map((t) =>
    `<div class="theme-row"><span class="theme-name">${escapeHtml(t.name)}</span><span class="theme-weight">${Math.round((t.weight || 0) * 100)}%</span><div class="theme-summary">${escapeHtml(t.summary)}</div></div>`
  ).join("");
  const emotions = (d.emotions || []).map((e) =>
    `<span class="emotion-chip">${escapeHtml(e.label)} ${"●".repeat(Math.max(1, Math.min(5, e.intensity)))}</span>`
  ).join(" ");
  const reread = (d.reread_post_ids || [])
    .map((id) => getPost(id))
    .filter(Boolean)
    .map((p) => `<blockquote><span class="q-meta">${fmtDateTime(p.createdAt)}</span>${renderBody(p.text)}</blockquote>`)
    .join("");

  const isRollup = ROLLUP_PERIOD_TYPES.includes(r.periodType);
  const countNote = isRollup
    ? `レポート${r.reportCount ?? "?"}件（雑記${r.postCount}件相当）を統合`
    : `雑記${r.postCount}件`;

  return `
  <article class="card report-card${isRollup ? " report-card-rollup" : ""}" data-report-id="${r.id}">
    <div class="report-head">
      <span class="report-period">${PERIOD_TYPE_LABEL[r.periodType] || r.periodType} ${escapeHtml(r.periodLabel)}</span>
      <span class="report-mood" title="AIが観測した気分スコア">${d.mood_score >= 0 ? "+" : ""}${Number(d.mood_score).toFixed(1)} ${TREND_LABEL[d.mood_trend] || ""}</span>
    </div>
    ${followUpHtml(r)}
    <div class="report-letter">${renderBody(d.letter)}</div>
    ${blindSpotHtml(r)}
    ${openLoopsHtml(r)}
    <details class="report-details">
      <summary>構造データを見る</summary>
      <h4>テーマ</h4>${themes || '<p class="muted">なし</p>'}
      <h4>感情の内訳</h4><p>${emotions || '<span class="muted">なし</span>'}</p>
      <h4>次の一手</h4><p><b>${escapeHtml(d.suggestion?.action || "")}</b><br><span class="muted">${escapeHtml(d.suggestion?.why || "")}</span></p>
      ${reread ? `<h4>読み返す価値のある雑記</h4>${reread}` : ""}
      <p class="muted report-meta">${countNote} / ${escapeHtml(r.model)}${pipelineNote(r.pipeline)} / ${fmtDateTime(r.createdAt)}
        <button class="pa-btn danger" data-report-delete="${r.id}">レポート削除</button></p>
    </details>
  </article>`;
}

function renderReportList() {
  const reports = getReports();
  if (reports.length === 0) {
    $("#reportList").innerHTML = `<p class="muted" style="margin:0 4px 14px">まだレポートはありません。週が完了したら、他者の目に読ませてみよう。</p>`;
    return;
  }
  $("#reportList").innerHTML = reports.map(reportCardHtml).join("");
}

document.body.addEventListener("click", (e) => {
  const del = e.target.closest("[data-report-delete]");
  if (del) {
    if (confirm("このレポートを削除しますか？（同じ期間で作り直せます）")) {
      deleteReport(del.dataset.reportDelete);
      renderReportView();
      updatePendingBanner();
    }
    return;
  }
  const fbBtn = e.target.closest("[data-fb-verdict]");
  if (fbBtn) {
    const wrap = fbBtn.closest("[data-feedback-report]");
    const reportId = wrap.dataset.feedbackReport;
    const note = wrap.querySelector(".fb-note")?.value.trim() || "";
    setReportFeedback(reportId, { blindSpot: { verdict: fbBtn.dataset.fbVerdict, note, at: new Date().toISOString() } });
    renderReportList();
  }
});

// 週次と月次は粒度が違うので同じ軸・同じ線に混ぜない
// （かつてのバグ: reportTimeSeries()がfromで全レポートをソートして1本の線に結び、
//   月次の点が週次の点の間に刺さって解釈不能になっていた）。
const META_TYPE_LABEL = { weekly: "📅 週次", monthly: "🗓 月次" };
const META_TYPE_COLOR = { weekly: "#7c3aed", monthly: "#c2703f" };

function metaMoodSvg(type, series) {
  const color = META_TYPE_COLOR[type] || "#7c3aed";
  const W = 640, H = 140, pad = 30;
  const step = series.length > 1 ? (W - pad * 2) / (series.length - 1) : 0;
  const y = (v) => H / 2 - (v / 2) * (H / 2 - 20);
  const pts = series.map((s, i) => ({ x: pad + i * step, y: y(s.mood), s }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dots = pts.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${color}"><title>${escapeHtml(p.s.label)}: ${p.s.mood.toFixed(1)}</title></circle>`
  ).join("");
  return `
    <p class="muted">${META_TYPE_LABEL[type] || type}（他者の目が観測した気分スコアの推移）</p>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${H / 2}" x2="${W - pad}" y2="${H / 2}" stroke="#e6e1f2" stroke-dasharray="4 4"/>
      <path d="${line}" stroke="${color}" stroke-width="2" fill="none"/>
      ${dots}
    </svg>`;
}

function renderMetaAnalysis() {
  const groups = reportTimeSeries();
  const totalReports = groups.reduce((sum, g) => sum + g.series.length, 0);
  if (totalReports < 2) {
    $("#metaCard").hidden = true;
    return;
  }
  $("#metaCard").hidden = false;

  $("#metaChart").innerHTML = groups
    .filter((g) => g.series.length > 0)
    .map((g) => metaMoodSvg(g.type, g.series))
    .join("");

  renderFollowThrough();
  renderThemeLifecycle();
  renderBlindSpotRepeat();
}

// テーマのライフサイクル — 単なる出現回数の羅列にせず、
// 「いま生きているテーマ」と「消えたテーマ」を分けて見せる（歴史の熟成の可視化）。
function renderThemeLifecycle() {
  const lifecycles = themeLifecycles(2);
  const el = $("#metaThemes");
  if (!el) return;
  if (lifecycles.length === 0) {
    el.innerHTML = "";
    return;
  }
  const chip = (e) => `<span class="emotion-chip" title="初出: ${escapeHtml(e.firstLabel)} / 最終: ${escapeHtml(e.lastLabel)}">${escapeHtml(e.name)} ×${e.count}</span>`;
  const active = lifecycles.filter((e) => e.active);
  const gone = lifecycles.filter((e) => !e.active);
  el.innerHTML = `
    ${active.length ? `<p class="muted">いま生きているテーマ（あなたの重心）:</p><p>${active.map(chip).join(" ")}</p>` : ""}
    ${gone.length ? `<p class="muted">消えたテーマ:</p><p>${gone.map(chip).join(" ")}</p>` : ""}`;
}

// 同じ盲点が繰り返し指摘されているかの検出。熟成ではなく停滞のサインなので目立たせる。
function renderBlindSpotRepeat() {
  const el = $("#metaBlindSpotRepeat");
  if (!el) return;
  const recurring = recurringBlindSpots(0.5);
  if (recurring.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <p class="muted">繰り返し指摘されている盲点（熟成ではなく停滞のサイン）:</p>
    ${recurring.map((c) => `
      <p class="blindspot-repeat-warn">「${escapeHtml(c.text)}」<span class="muted"> — ${c.count}回（${c.labels.map(escapeHtml).join(" / ")}）</span></p>
    `).join("")}`;
}

// 提案の実行率 — 「他者の一手」が実際に閉じているかの指標。
// 追跡フィールドを持たないv1レポートは分母に入れない。
function renderFollowThrough() {
  const ft = suggestionFollowThrough();
  const el = $("#metaFollowThrough");
  if (ft.total === 0) {
    el.innerHTML = "";
    return;
  }
  const rate = ft.rate == null ? "—" : `${Math.round(ft.rate * 100)}%`;
  const chips = [
    `<span class="emotion-chip">✅ 実行 ${ft.done}</span>`,
    `<span class="emotion-chip">🔸 部分 ${ft.partial}</span>`,
    `<span class="emotion-chip">⭕️ 手つかず ${ft.not_done}</span>`,
    ft.unknown ? `<span class="emotion-chip">— 判定不能 ${ft.unknown}</span>` : "",
  ].join(" ");
  el.innerHTML = `
    <p class="muted">提案の実行率（追跡できるレポート${ft.total}件のうち、判定できた${ft.judged}件が分母）:</p>
    <p class="follow-rate">${rate}</p>
    <p>${chips}</p>`;
}

// 自己申告の気分（コンポーザーで記録した mood）と、AIが観測した気分（レポートの
// mood_score）を重ねる。「自己認識と他者観測のズレ」＝自己分析の核心。
// 週次・月次は粒度が違うので同じ線に混ぜない（#metaChart と同じ轍を踏まない）。
const GAP_TYPE_LABEL = { weekly: "📅 週次", monthly: "🗓 月次" };
const MOOD_GAP_THRESHOLD = 0.8;

function renderMoodGap() {
  const series = selfReportedMoodByPeriod();
  if (series.length < 2) {
    $("#moodGapCard").hidden = true;
    return;
  }
  $("#moodGapCard").hidden = false;

  const groups = new Map();
  series.forEach((s) => {
    if (!groups.has(s.periodType)) groups.set(s.periodType, []);
    groups.get(s.periodType).push(s);
  });

  const divergent = [];
  $("#moodGapChart").innerHTML = Array.from(groups.entries())
    .map(([type, pts]) => moodGapSvg(GAP_TYPE_LABEL[type] || type, pts, divergent))
    .join("");

  $("#moodGapNote").innerHTML = divergent.length
    ? `<p class="mood-gap-warn">この期間、あなたの自己申告と他者の観測は大きくズレている: ${divergent.map(escapeHtml).join(" / ")}</p>`
    : "";
}

function moodGapSvg(label, pts, divergentOut) {
  const W = 640, H = 140, pad = 30;
  const step = pts.length > 1 ? (W - pad * 2) / (pts.length - 1) : 0;
  const y = (v) => H / 2 - (v / 2) * (H / 2 - 20);
  const x = (i) => pad + i * step;

  // どちらの観測も大きくズレている点だけ強調する（自己申告が無い期間は判定不能）
  const big = pts.map((p) => p.selfMood != null && Math.abs(p.selfMood - p.aiMood) >= MOOD_GAP_THRESHOLD);
  big.forEach((isBig, i) => { if (isBig) divergentOut.push(pts[i].label); });

  // 自己申告は実線。値が無い期間は線を途切れさせる（0として描かない）
  let selfPath = "";
  let drawing = false;
  pts.forEach((p, i) => {
    if (p.selfMood == null) { drawing = false; return; }
    selfPath += `${drawing ? "L" : "M"} ${x(i).toFixed(1)} ${y(p.selfMood).toFixed(1)} `;
    drawing = true;
  });
  selfPath = selfPath.trim();

  // AI観測は破線。全期間に値がある前提（レポートには必ずmood_scoreがある）
  const aiPath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.aiMood).toFixed(1)}`).join(" ");

  const selfDots = pts.map((p, i) => p.selfMood == null ? "" :
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.selfMood).toFixed(1)}" r="${big[i] ? 6 : 3.5}" fill="#a9b23f"><title>${escapeHtml(p.label)} 自己申告: ${p.selfMood.toFixed(1)}</title></circle>`
  ).join("");
  const aiDots = pts.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.aiMood).toFixed(1)}" r="${big[i] ? 6 : 3.5}" fill="#3f78c2"><title>${escapeHtml(p.label)} AI観測: ${Number(p.aiMood).toFixed(1)}</title></circle>`
  ).join("");

  return `
    <p class="muted">${label}（実線: 自己申告 / 破線: AI観測）</p>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${H / 2}" x2="${W - pad}" y2="${H / 2}" stroke="#e6e1f2" stroke-dasharray="4 4"/>
      ${selfPath ? `<path d="${selfPath}" stroke="#a9b23f" stroke-width="2" fill="none"/>` : ""}
      <path d="${aiPath}" stroke="#3f78c2" stroke-width="2" stroke-dasharray="5 4" fill="none"/>
      ${aiDots}
      ${selfDots}
    </svg>`;
}

// ---------- ローカル統計 ----------

function renderMoodChart() {
  const posts = postsInLastDays(getPosts(), 30).filter((p) => p.mood != null);
  if (posts.length === 0) {
    $("#moodChart").innerHTML = `<p class="muted">気分つきのポストがまだありません。コンポーザーの顔アイコンで気分を記録できます。</p>`;
    return;
  }

  const byDay = new Map();
  posts.forEach((p) => {
    const day = p.createdAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p.mood);
  });

  const W = 640, H = 160, pad = 24;
  const now = new Date();
  const pts = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const moods = byDay.get(key);
    if (moods) {
      const avg = moods.reduce((a, b) => a + b, 0) / moods.length;
      const x = pad + ((29 - i) / 29) * (W - pad * 2);
      const yy = H / 2 - (avg / 2) * (H / 2 - pad);
      pts.push({ x, y: yy, avg, key });
    }
  }

  const zero = H / 2;
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dots = pts.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${p.avg >= 0 ? "#a9b23f" : "#3f78c2"}"><title>${p.key}: ${p.avg.toFixed(1)}</title></circle>`
  ).join("");

  $("#moodChart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${zero}" x2="${W - pad}" y2="${zero}" stroke="#e6e1f2" stroke-dasharray="4 4"/>
      <text x="${pad}" y="${pad - 8}" font-size="10" fill="#8d84a3">+2</text>
      <text x="${pad}" y="${H - pad + 16}" font-size="10" fill="#8d84a3">-2</text>
      ${pts.length > 1 ? `<path d="${line}" stroke="#7c3aed" stroke-width="2" fill="none"/>` : ""}
      ${dots}
    </svg>`;
}

function renderLocalStats() {
  const posts = getPosts();
  localAnalysis(postsInLastDays(posts, 30), "直近1ヶ月").then((text) => {
    $("#localStats").innerHTML = text.split("\n")
      .filter(Boolean)
      .map((l) => `<p class="stat-line">${escapeHtml(l)}</p>`)
      .join("");
  });
}

// ---------- 設定 ----------

function renderSettings() {
  const s = getSettings();
  $("#providerSelect").value = s.provider;
  $("#anthropicKeyInput").value = s.anthropicKey || "";
  $("#geminiKeyInput").value = s.geminiKey || "";
  $("#anthropicModelSelect").innerHTML = PROVIDERS.anthropic.models
    .map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  $("#geminiModelSelect").innerHTML = PROVIDERS.gemini.models
    .map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  $("#anthropicModelSelect").value = s.anthropicModel;
  $("#geminiModelSelect").value = s.geminiModel;
  $("#aiAutoReply").checked = Boolean(s.aiAutoReply);
  $("#reportWorkflowSelect").value = s.reportWorkflow || "auto";
  $("#freeTierRpmInput").value = Number(s.freeTierRpm) > 0 ? s.freeTierRpm : 10;
  toggleProviderFields();
}

function toggleProviderFields() {
  const p = $("#providerSelect").value;
  $("#anthropicFields").hidden = p !== "anthropic";
  $("#geminiFields").hidden = p !== "gemini";
}
$("#providerSelect").addEventListener("change", toggleProviderFields);

$("#saveSettingsBtn").addEventListener("click", () => {
  saveSettings({
    provider: $("#providerSelect").value,
    anthropicKey: $("#anthropicKeyInput").value.trim(),
    anthropicModel: $("#anthropicModelSelect").value,
    geminiKey: $("#geminiKeyInput").value.trim(),
    geminiModel: $("#geminiModelSelect").value,
    aiAutoReply: $("#aiAutoReply").checked,
    reportWorkflow: $("#reportWorkflowSelect").value,
    freeTierRpm: Math.max(1, Math.min(60, Number($("#freeTierRpmInput").value) || 10)),
  });
  $("#settingsSaved").textContent = "保存しました";
  setTimeout(() => { $("#settingsSaved").textContent = ""; }, 2000);
});

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
  if (!confirm("本当にすべての雑記とレポートを削除しますか？この操作は取り消せません。")) return;
  if (!confirm("最終確認：ブドウの木も種に戻ります。削除しますか？")) return;
  wipeAll();
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

function renderAll() {
  renderMoodPicker();
  renderFeed();
  renderSettings();
  renderSyncUI();
  updateVineBadge();
  updateTicker();
  updateThreadHint();
  updatePendingBanner();
}

renderAll();

// クラウド同期の起動（設定済みかつログイン済みなら初回同期）
initSync({
  onApplied: () => renderAll(),
});

// ---------- Service Worker登録（オフライン起動用。失敗しても致命的ではないので無視する） ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
