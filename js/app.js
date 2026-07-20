import {
  KINDS, MOODS,
  getPosts, getPost, getSettings, saveSettings,
  addPost, deletePost, setAiReply,
  activeDays, daysSinceFirstPost,
  exportJson, importJson, wipeAll,
} from "./store.js";
import { massOf, milestoneBonus, pickForTicker, ageInDays } from "./mass.js";
import { STAGES, stageOf, nextStage, isSprouted, bunchCount, renderVineSvg } from "./vine.js";
import { analyzePeriod, replyToPost, postsInLastDays, hasApiKey, localAnalysis } from "./ai.js";

const $ = (sel) => document.querySelector(sel);

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

const views = ["timeline", "timeaxis", "vine", "analysis", "settings"];

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
  if (name === "analysis") renderAnalysis();
}

// ---------- コンポーザー ----------

let selectedKind = KINDS[0];
let selectedMood = null;

function renderKindPicker() {
  $("#kindPicker").innerHTML = KINDS.map(
    (k) => `<button class="kind-chip ${k === selectedKind ? "active" : ""}" data-kind="${k}">${k}</button>`
  ).join("");
}
$("#kindPicker").addEventListener("click", (e) => {
  const chip = e.target.closest(".kind-chip");
  if (!chip) return;
  selectedKind = chip.dataset.kind;
  renderKindPicker();
});

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

$("#postBtn").addEventListener("click", () => {
  const text = $("#composerText").value.trim();
  if (!text) return;
  const post = addPost({ text, kind: selectedKind, mood: selectedMood });
  $("#composerText").value = "";
  $("#charCount").textContent = "";
  selectedMood = null;
  renderMoodPicker();
  renderFeed();
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

function postHtml(post, { showActions = true } = {}) {
  const ref = post.refId ? getPost(post.refId) : null;
  const mass = massOf(post);

  let repostNote = "";
  let quoteBlock = "";
  if (post.type === "repost" && ref) {
    repostNote = `<div class="repost-note">🔁 過去の自分を再掲（再芽）</div>`;
  }
  if (ref && (post.type === "quote" || post.type === "repost")) {
    quoteBlock = `<blockquote><span class="q-meta">${fmtDateTime(ref.createdAt)}（${fmtAgo(ref.createdAt)}） [${escapeHtml(ref.kind)}]</span>${renderBody(ref.text)}</blockquote>`;
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

  return `
  <article class="post" data-id="${post.id}">
    ${repostNote}
    <div class="post-head">
      <span class="post-kind">${escapeHtml(post.kind)}</span>
      <span>${fmtDateTime(post.createdAt)}</span>
      <span>${fmtAgo(post.createdAt)}</span>
      ${post.mood != null ? `<span class="post-mood">${moodEmoji(post.mood)}</span>` : ""}
      <span class="post-mass" title="質量（引用・再掲で重くなる）">◉ ${mass.toFixed(1)}</span>
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
  $("#feed").innerHTML = posts.map((p) => postHtml(p)).join("");
}

// フィード内アクション（イベント委譲）
document.body.addEventListener("click", async (e) => {
  const btn = e.target.closest(".pa-btn");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const post = getPost(id);
  if (!post) return;

  if (action === "repost") {
    addPost({ text: "", kind: post.kind, type: "repost", refId: post.id });
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
      alert("設定タブでAnthropic APIキーを登録すると、AIが返信してくれます。");
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
  addPost({ text, kind: selectedKind, type: "quote", refId: quoteTargetId });
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

// ---------- 分析ビュー ----------

function renderAnalysis() {
  renderMoodChart();
  renderLocalStats();
}

function renderMoodChart() {
  const posts = postsInLastDays(getPosts(), 30).filter((p) => p.mood != null);
  if (posts.length === 0) {
    $("#moodChart").innerHTML = `<p class="muted">気分つきのポストがまだありません。コンポーザーの顔アイコンで気分を記録できます。</p>`;
    return;
  }

  // 日ごとの平均気分
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
      const y = H / 2 - (avg / 2) * (H / 2 - pad);
      pts.push({ x, y, avg, key });
    }
  }

  const zero = H / 2;
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dots = pts.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${p.avg >= 0 ? "#cfd66a" : "#6a9ad6"}"><title>${p.key}: ${p.avg.toFixed(1)}</title></circle>`
  ).join("");

  $("#moodChart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${zero}" x2="${W - pad}" y2="${zero}" stroke="#383150" stroke-dasharray="4 4"/>
      <text x="${pad}" y="${pad - 8}" font-size="10" fill="#9a92b5">+2</text>
      <text x="${pad}" y="${H - pad + 16}" font-size="10" fill="#9a92b5">-2</text>
      ${pts.length > 1 ? `<path d="${line}" stroke="#8f6ee0" stroke-width="2" fill="none"/>` : ""}
      ${dots}
    </svg>`;
}

function renderLocalStats() {
  const posts = getPosts();
  localAnalysis(postsInLastDays(posts, 30), "直近1ヶ月").then((text) => {
    // ローカル分析の末尾の案内文はここでは省く
    $("#localStats").innerHTML = text.split("\n")
      .filter((l) => l && !l.startsWith("※"))
      .map((l) => `<p class="stat-line">${escapeHtml(l)}</p>`)
      .join("");
  });
}

$("#aiAnalyzeBtn").addEventListener("click", async () => {
  const days = Number($("#aiPeriod").value);
  const label = $("#aiPeriod").selectedOptions[0].textContent;
  const posts = postsInLastDays(getPosts(), days);
  const btn = $("#aiAnalyzeBtn");
  btn.disabled = true;
  $("#aiResult").innerHTML = `<span class="spin">🍇</span> ${hasApiKey() ? "AIがあなたの記録を読んでいます…" : "ローカル分析中…"}`;
  try {
    const result = await analyzePeriod(posts, label);
    $("#aiResult").textContent = result;
  } catch (err) {
    $("#aiResult").textContent = `エラー: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- 設定 ----------

function renderSettings() {
  const s = getSettings();
  $("#apiKeyInput").value = s.apiKey || "";
  $("#modelSelect").value = s.model || "claude-opus-4-8";
  $("#aiAutoReply").checked = Boolean(s.aiAutoReply);
}

$("#saveSettingsBtn").addEventListener("click", () => {
  saveSettings({
    apiKey: $("#apiKeyInput").value.trim(),
    model: $("#modelSelect").value,
    aiAutoReply: $("#aiAutoReply").checked,
  });
  $("#settingsSaved").textContent = "保存しました";
  setTimeout(() => { $("#settingsSaved").textContent = ""; }, 2000);
});

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([exportJson()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cns-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    if (!confirm("現在のポストをインポート内容で置き換えます。よろしいですか？")) return;
    importJson(text);
    renderAll();
    alert("インポートしました");
  } catch (err) {
    alert(`インポート失敗: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

$("#wipeBtn").addEventListener("click", () => {
  if (!confirm("本当にすべてのポストを削除しますか？この操作は取り消せません。")) return;
  if (!confirm("最終確認：ブドウの木も種に戻ります。削除しますか？")) return;
  wipeAll();
  renderAll();
});

// ---------- 初期化 ----------

function renderAll() {
  renderKindPicker();
  renderMoodPicker();
  renderFeed();
  renderSettings();
  updateVineBadge();
  updateTicker();
}

renderAll();
