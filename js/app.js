import {
  MOODS,
  getPosts, getPost, getSettings, saveSettings,
  addPost, deletePost, setAiReply,
  breakThreadLink,
  getReports, deleteReport,
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
import { listGeneratablePeriods, pendingWeekly, generateReport, reportTimeSeries, recurringThemes, suggestionFollowThrough } from "./report.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- ユーティリティ ----------

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderBody(text) {
  return escapeHtml(text).replace(/#([^\s#<]+)/g, '<span class="tag">#$1</span>');
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

function renderFeed() {
  const posts = getPosts();
  if (posts.length === 0) {
    $("#feed").innerHTML = `<div class="feed-empty">まだ何もない。ここはあなたと、やがて芽吹く過去のあなただけの場所。<br>最初のひと粒を刻もう。</div>`;
    return;
  }
  // タイムライン全体は新しい順。ただし「連（スレッド）＝連続投稿の一息の塊」は、
  // その内部だけ時系列順（古い→新しい＝上→下）に並べ替え、1つの .thread ブロックに
  // まとめて描く。連は書いた順に上から読めるようにし、連と連の間は従来どおり新しい順
  // を保つ（＝下に行くほど過去）。投稿どうしの継ぎ目は薄い区切り線だけにして「1つの
  // まとまり」に見せ、その線の端に小さなハサミを置いて、そこから連を断ち切れるようにする。
  const parts = [];
  let i = 0;
  while (i < posts.length) {
    const p = posts[i];
    if (!p.threadId) { parts.push(postHtml(p)); i++; continue; }

    // 同じ threadId が続く範囲 [i, j]（posts は新しい順）を求める。
    let j = i;
    while (j + 1 < posts.length && posts[j + 1].threadId === p.threadId) j++;

    // 連の内部は古い順に反転して、頭（起点）を上・続きを下にして並べる。
    const chrono = posts.slice(i, j + 1).reverse();
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
    parts.push(`<div class="thread">${inner.join("")}</div>`);
    i = j + 1;
  }
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

// ---------- 電光掲示板（ティッカー） ----------

function updateTicker() {
  const days = activeDays();
  const sprouted = isSprouted(days);
  const posts = getPosts();

  if (!sprouted) {
    $("#tickerWrap").hidden = true;
    if (posts.length > 0) {
      $("#tickerLocked").hidden = false;
      $("#tickerLockedMsg").textContent = `あと${7 - days}日活動すると発芽し、過去の自分がここに流れ始めます（現在 ${days}/7日）`;
    } else {
      $("#tickerLocked").hidden = true;
    }
    return;
  }

  const picked = pickForTicker(posts, 12);
  if (picked.length === 0) {
    $("#tickerWrap").hidden = true;
    $("#tickerLocked").hidden = false;
    $("#tickerLockedMsg").textContent = "発芽しました。3日以上前のポストが増えると、ここに過去の自分が流れます。";
    return;
  }

  $("#tickerLocked").hidden = true;
  $("#tickerWrap").hidden = false;

  const itemsHtml = picked.map((p) => {
    const { label } = milestoneBonus(p);
    const when = label || fmtAgo(p.createdAt);
    const text = p.text.length > 60 ? p.text.slice(0, 60) + "…" : p.text;
    return `<span class="ticker-item" data-id="${p.id}"><span class="t-when">${when}の自分</span>${escapeHtml(text)}</span>`;
  }).join("");

  // シームレスにループさせるため2周分並べる
  const track = $("#tickerTrack");
  track.innerHTML = itemsHtml + itemsHtml;
  const dur = Math.max(30, picked.length * 8);
  track.style.animationDuration = `${dur}s`;
}

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

function renderReportView() {
  renderPeriodSelect();
  renderMetaAnalysis();
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
    `<option value="${i}">${p.type === "weekly" ? "📅 週次" : "🗓 月次"} ${p.label}（${p.count}件）</option>`
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

  return `
  <article class="card report-card" data-report-id="${r.id}">
    <div class="report-head">
      <span class="report-period">${r.periodType === "weekly" ? "📅" : "🗓"} ${escapeHtml(r.periodLabel)}</span>
      <span class="report-mood" title="AIが観測した気分スコア">${d.mood_score >= 0 ? "+" : ""}${Number(d.mood_score).toFixed(1)} ${TREND_LABEL[d.mood_trend] || ""}</span>
    </div>
    ${followUpHtml(r)}
    <div class="report-letter">${renderBody(d.letter)}</div>
    ${openLoopsHtml(r)}
    <details class="report-details">
      <summary>構造データを見る</summary>
      <h4>テーマ</h4>${themes || '<p class="muted">なし</p>'}
      <h4>感情の内訳</h4><p>${emotions || '<span class="muted">なし</span>'}</p>
      <h4>盲点</h4><p>${escapeHtml(d.blind_spot || "")}</p>
      ${d.contradiction ? `<h4>矛盾・ズレ</h4><p>${escapeHtml(d.contradiction)}</p>` : ""}
      <h4>次の一手</h4><p><b>${escapeHtml(d.suggestion?.action || "")}</b><br><span class="muted">${escapeHtml(d.suggestion?.why || "")}</span></p>
      ${reread ? `<h4>読み返す価値のある雑記</h4>${reread}` : ""}
      <p class="muted report-meta">雑記${r.postCount}件 / ${escapeHtml(r.model)}${pipelineNote(r.pipeline)} / ${fmtDateTime(r.createdAt)}
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
  if (!del) return;
  if (confirm("このレポートを削除しますか？（同じ期間で作り直せます）")) {
    deleteReport(del.dataset.reportDelete);
    renderReportView();
    updatePendingBanner();
  }
});

function renderMetaAnalysis() {
  const series = reportTimeSeries();
  if (series.length < 2) {
    $("#metaCard").hidden = true;
    return;
  }
  $("#metaCard").hidden = false;

  // AI観測の気分スコア推移
  const W = 640, H = 140, pad = 30;
  const step = (W - pad * 2) / Math.max(1, series.length - 1);
  const y = (v) => H / 2 - (v / 2) * (H / 2 - 20);
  const pts = series.map((s, i) => ({ x: pad + i * step, y: y(s.mood), s }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dots = pts.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${p.s.mood >= 0 ? "#a9b23f" : "#3f78c2"}"><title>${p.s.label}: ${p.s.mood.toFixed(1)}</title></circle>`
  ).join("");
  $("#metaChart").innerHTML = `
    <p class="muted">他者の目が観測した気分スコアの推移（レポートごと）</p>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${H / 2}" x2="${W - pad}" y2="${H / 2}" stroke="#e6e1f2" stroke-dasharray="4 4"/>
      <path d="${line}" stroke="#7c3aed" stroke-width="2" fill="none"/>
      ${dots}
    </svg>`;

  renderFollowThrough();

  const recur = recurringThemes(2);
  $("#metaThemes").innerHTML = recur.length
    ? `<p class="muted">繰り返し現れるテーマ（あなたの重心）:</p><p>${recur.map(([name, c]) => `<span class="emotion-chip">${escapeHtml(name)} ×${c}</span>`).join(" ")}</p>`
    : "";
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
