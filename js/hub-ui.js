// 統合ハブのUI — MEMOの雑記と外部SNSの投稿を1本のタイムラインで閲覧し、分析・抽出する。

import { getPosts, MOODS } from "./store.js";
import {
  SOURCES, SOURCE_ORDER, sourceMeta, getExternal, addExternal, deleteExternal, clearSource,
  getHubSettings, saveHubSettings, isMine, importAuto, analyze, toCsv, toJson, onHubChange,
} from "./hub.js";
import { callAIPaced, hasApiKey, SYSTEM_PROMPT } from "./ai.js";

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function linkify(text) {
  return escapeHtml(text)
    .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.length > 48 ? u.slice(0, 48) + "…" : u}</a>`)
    .replace(/(^|\s)[#＃]([^\s#＃<]+)/g, '$1<span class="tag" data-hub-word="#$2">#$2</span>');
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function moodEmoji(mood) {
  return MOODS.find((m) => m.value === mood)?.emoji || "";
}

// ---- 状態 ----

const PAGE = 100;
const state = {
  sources: new Set(SOURCE_ORDER),
  text: "",
  from: "",
  to: "",
  mineOnly: false,
  sort: "new",          // new | old | like
  sub: "list",          // list | analyze
  visible: PAGE,
};
let ext = { connected: false, version: "", received: 0 };

// MEMOの雑記を統合リスト用の形に揃える（中身はそのまま参照）
function memoItems() {
  return getPosts()
    .filter((p) => p.text && p.text.trim())
    .map((p) => ({
      id: `memo:${p.id}`,
      memoId: p.id,
      source: "memo",
      text: p.text,
      createdAt: p.createdAt,
      tags: p.tags || [],
      mood: p.mood,
      author: "",
      url: "",
      metrics: {},
    }));
}

function allItems() {
  return [...memoItems(), ...getExternal()];
}

function matches(it) {
  const key = SOURCES[it.source] ? it.source : "web"; // 未知のソースは「Web」に寄せる
  if (!state.sources.has(key)) return false;
  if (state.mineOnly && !isMine(it)) return false;
  const day = it.createdAt.slice(0, 10);
  if (state.from && day < state.from) return false;
  if (state.to && day > state.to) return false;
  if (state.text) {
    const hay = `${it.text} ${it.author || ""} ${it.authorName || ""}`.toLowerCase();
    // スペース区切りはAND、先頭が - なら除外
    for (const term of state.text.split(/\s+/).filter(Boolean)) {
      if (term.startsWith("-") && term.length > 1) {
        if (hay.includes(term.slice(1))) return false;
      } else if (!hay.includes(term)) return false;
    }
  }
  return true;
}

function filtered() {
  const list = allItems().filter(matches);
  if (state.sort === "old") list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  else if (state.sort === "like") list.sort((a, b) => (b.metrics?.like || 0) - (a.metrics?.like || 0));
  else list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list;
}

// ---- 描画 ----

function itemHtml(it) {
  const m = sourceMeta(it.source);
  const who = it.source === "memo"
    ? `<span class="hub-who">自分${it.mood != null ? " " + moodEmoji(it.mood) : ""}</span>`
    : `<span class="hub-who">${escapeHtml(it.authorName || "")}${it.author ? ` <span class="muted">@${escapeHtml(it.author)}</span>` : ""}${isMine(it) ? ' <span class="hub-mine">自分</span>' : ""}</span>`;
  const metrics = [];
  if (it.metrics?.reply) metrics.push(`💬 ${it.metrics.reply}`);
  if (it.metrics?.repost) metrics.push(`🔁 ${it.metrics.repost}`);
  if (it.metrics?.like) metrics.push(`♥ ${it.metrics.like}`);
  if (it.metrics?.view) metrics.push(`👁 ${it.metrics.view}`);
  const media = (it.media || []).length ? `<span class="muted">🖼 ${it.media.length}</span>` : "";
  const open = it.url ? `<a class="hub-act" href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer">↗ 元を開く</a>` : "";
  const share = it.source === "memo"
    ? `<a class="hub-act" href="https://x.com/intent/post?text=${encodeURIComponent(it.text.slice(0, 270))}" target="_blank" rel="noopener noreferrer" title="Xの投稿画面を開く（自動投稿はしません）">𝕏 Xにも投稿</a>`
    : `<button class="hub-act danger" data-hub-action="delete" data-id="${escapeHtml(it.id)}">削除</button>`;
  return `
  <article class="post hub-item" style="--src:${m.color}">
    <div class="post-head">
      <span class="hub-src" title="${escapeHtml(m.label)}">${m.icon} ${escapeHtml(m.label)}</span>
      ${who}
      <span>${fmtDateTime(it.createdAt)}</span>
      ${it.isRepost ? '<span class="muted">🔁 リポスト</span>' : ""}
      ${it.replyTo ? `<span class="muted">↩ @${escapeHtml(it.replyTo)}</span>` : ""}
    </div>
    <div class="post-body">${linkify(it.text)}</div>
    <div class="hub-foot">
      <span class="hub-metrics">${metrics.join("　")} ${media}</span>
      <span class="hub-actions">${open}${share}</span>
    </div>
  </article>`;
}

function renderSourceChips(all) {
  const counts = {};
  all.forEach((it) => { counts[it.source] = (counts[it.source] || 0) + 1; });
  $("#hubSourceChips").innerHTML = SOURCE_ORDER.map((k) => [k, SOURCES[k]]).map(([k, m]) =>
    `<button class="tag-chip${state.sources.has(k) ? " active" : ""}" data-hub-source="${k}">${m.icon} ${m.label} <span class="tag-count">${counts[k] || 0}</span></button>`
  ).join("");
}

function renderList(list) {
  const feed = $("#hubFeed");
  if (list.length === 0) {
    feed.innerHTML = `<div class="feed-empty">${allItems().length === 0
      ? "まだ何もありません。上の「取り込み」からXのアーカイブを読み込むか、Chrome拡張でX・755を閲覧すると、ここに集まります。"
      : "条件に一致する投稿はありません。"}</div>`;
    return;
  }
  const shown = list.slice(0, state.visible);
  feed.innerHTML = shown.map(itemHtml).join("") +
    (list.length > shown.length ? `<button class="btn load-more-btn" id="hubMoreBtn">さらに表示（残り${list.length - shown.length}件）</button>` : "");
}

// ---- グラフ（依存ゼロの素のSVG） ----

function barsSvg(values, labels, { color = "var(--accent)", height = 110 } = {}) {
  const max = Math.max(1, ...values);
  const w = 100 / values.length;
  const bars = values.map((v, i) => {
    const h = (v / max) * (height - 22);
    return `<g><title>${labels[i]}: ${v}件</title><rect x="${i * w + w * 0.15}%" y="${height - 16 - h}" width="${w * 0.7}%" height="${h}" rx="2" fill="${color}"></rect></g>`;
  }).join("");
  const ticks = labels.map((l, i) => (labels.length > 12 && i % 3 !== 0) ? "" :
    `<text x="${i * w + w / 2}%" y="${height - 3}" text-anchor="middle" font-size="9" fill="var(--muted)">${l}</text>`).join("");
  return `<svg class="hub-chart" width="100%" height="${height}" role="img">${bars}${ticks}</svg>`;
}

function monthlySvg(months) {
  const rows = months.slice(-24);
  if (rows.length === 0) return "";
  const height = 130;
  const totals = rows.map(([, r]) => Object.values(r).reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const w = 100 / Math.max(rows.length, 12); // 月数が少ないときに棒が太くなりすぎない
  const order = SOURCE_ORDER;
  const bars = rows.map(([mk, r], i) => {
    let y = height - 18;
    const tip = `${mk}: ` + order.filter((s) => r[s]).map((s) => `${SOURCES[s].label} ${r[s]}`).join(" / ");
    const segs = order.filter((s) => r[s]).map((s) => {
      const h = (r[s] / max) * (height - 26);
      y -= h;
      return `<rect x="${i * w + w * 0.15}%" y="${y}" width="${w * 0.7}%" height="${h}" fill="${SOURCES[s].color}"></rect>`;
    }).join("");
    return `<g><title>${tip}</title>${segs}</g>`;
  }).join("");
  const ticks = rows.map(([mk], i) => (rows.length > 8 && i % Math.ceil(rows.length / 8) !== 0) ? "" :
    `<text x="${i * w + w / 2}%" y="${height - 4}" text-anchor="middle" font-size="9" fill="var(--muted)">${mk.slice(2).replace("-", "/")}</text>`).join("");
  return `<svg class="hub-chart" width="100%" height="${height}" role="img">${bars}${ticks}</svg>`;
}

function chipList(pairs, prefix = "") {
  if (pairs.length === 0) return '<p class="muted">（なし）</p>';
  return `<div class="filter-tags">${pairs.map(([w, c]) =>
    `<button class="tag-chip" data-hub-word="${escapeHtml(prefix + w)}">${escapeHtml(prefix + w)} <span class="tag-count">${c}</span></button>`
  ).join("")}</div>`;
}

function renderAnalysis(list) {
  const a = analyze(list);
  const el = $("#hubAnalysis");
  if (a.total === 0) {
    el.innerHTML = '<p class="muted">分析対象がありません。絞り込み条件を見直してください。</p>';
    return;
  }
  const srcBar = a.bySource.map(([s, n]) => {
    const m = sourceMeta(s);
    return `<div class="hub-srcbar"><span>${m.icon} ${escapeHtml(m.label)}</span><div class="hub-srcbar-track"><div style="width:${(n / a.total) * 100}%;background:${m.color}"></div></div><span class="muted">${n}件</span></div>`;
  }).join("");
  const peakHour = a.hours.indexOf(Math.max(...a.hours));
  const wd = ["日", "月", "火", "水", "木", "金", "土"];
  const peakWd = a.weekdays.indexOf(Math.max(...a.weekdays));
  el.innerHTML = `
    <p class="stat-line">対象 <b>${a.total}</b>件（うち自分 ${a.mine}件）・平均 ${a.avgLength}文字・よく書く時間帯 <b>${peakHour}時台</b>・曜日 <b>${wd[peakWd]}曜</b></p>
    <h3>ソース別</h3>${srcBar}
    <h3>月ごとの量（直近24ヶ月）</h3>${monthlySvg(a.months)}
    <h3>時間帯</h3>${barsSvg(a.hours, a.hours.map((_, i) => `${i}`))}
    <h3>曜日</h3>${barsSvg(a.weekdays, wd, { color: "var(--leaf)", height: 90 })}
    <h3>よく出る言葉 <span class="muted">（タップで抽出）</span></h3>${chipList(a.topWords)}
    <h3>ハッシュタグ</h3>${chipList(a.topTags, "#")}
    <h3>よく言及する相手</h3>${chipList(a.topMentions, "@")}
  `;
}

function renderExtStatus() {
  const el = $("#hubExtStatus");
  if (!el) return;
  el.innerHTML = ext.connected
    ? `<span class="sync-dot ok"></span>Chrome拡張と接続中${ext.version ? `（v${escapeHtml(ext.version)}）` : ""}${ext.received ? ` — このセッションで${ext.received}件受信` : ""}`
    : `<span class="sync-dot"></span>Chrome拡張は未検出（<code>extension/</code> を読み込むと、X・755の閲覧中に自動で集まります）`;
}

export function renderHub() {
  const all = allItems();
  renderSourceChips(all);
  renderExtStatus();
  const s = getHubSettings();
  $("#hubHandleX").value = s.myHandles.x || "";
  $("#hubHandle755").value = s.myHandles["755"] || "";
  $("#hubSyncExternal").checked = Boolean(s.syncExternal);
  $("#hubBrewExternal").checked = s.brewExternal !== false;
  $("#hubMineOnly").checked = state.mineOnly;
  $("#hubSort").value = state.sort;

  const list = filtered();
  const active = state.text || state.from || state.to || state.mineOnly || state.sources.size < Object.keys(SOURCES).length;
  $("#hubCount").textContent = `${list.length}件${active ? `（全${all.length}件中）` : ""}`;
  $("#hubClearBtn").hidden = !active;

  document.querySelectorAll("[data-hub-sub]").forEach((b) => b.classList.toggle("active", b.dataset.hubSub === state.sub));
  $("#hubFeed").hidden = state.sub !== "list";
  $("#hubAnalysis").hidden = state.sub !== "analyze";
  if (state.sub === "list") renderList(list);
  else renderAnalysis(list);
}

// ---- 拡張との橋渡し ----
// extension/bridge.js（このページに挿入されるコンテンツスクリプト）と window.postMessage でやり取りする。
//   拡張 → ページ: { channel: "memo-hub-ext", type: "hello", version } / { type: "items", items: [...] }
//   ページ → 拡張: { channel: "memo-hub-page", type: "request" } / { type: "ack", keys: [...] }

function initBridge() {
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.channel !== "memo-hub-ext") return;
    if (d.type === "hello") {
      ext.connected = true;
      ext.version = String(d.version || "");
      renderExtStatus();
    }
    if (d.type === "items" && Array.isArray(d.items)) {
      ext.connected = true;
      const res = addExternal(d.items);
      ext.received += res.added;
      window.postMessage({ channel: "memo-hub-page", type: "ack", keys: d.items.map((it) => it.key || `${it.source}:${it.sourceId}`) }, location.origin);
      renderExtStatus();
    }
  });
  window.postMessage({ channel: "memo-hub-page", type: "request" }, location.origin);
}

// ---- AI分析 ----

async function runAiAnalysis(list) {
  const out = $("#hubAiResult");
  if (!hasApiKey()) {
    out.innerHTML = '<p class="muted">設定タブでAPIキーを登録すると、絞り込んだ投稿をAIが横断分析します。</p>';
    return;
  }
  const sample = list.slice(0, 300);
  const lines = sample.map((it) =>
    `[${sourceMeta(it.source).label}${isMine(it) ? "/自分" : it.author ? "/@" + it.author : ""}] ${it.createdAt.slice(0, 16).replace("T", " ")} ${it.text.replace(/\s+/g, " ").slice(0, 280)}`
  ).join("\n");
  out.innerHTML = '<p><span class="spin">🤖</span> 分析中…</p>';
  try {
    const text = await callAIPaced({
      system: SYSTEM_PROMPT + "\n\nいまは、本人がMEMO（自分だけの場所）と外部SNS（X・755など人に見せる場所）に書いた投稿を横断して読んでいます。",
      user: `以下は絞り込んだ${sample.length}件の投稿です（新しい順${list.length > sample.length ? `、全${list.length}件中の先頭` : ""}）。

次の観点で、日本語で簡潔に分析してください（見出しつき・各3〜5行）:
1. 主要なテーマと、その時期による移り変わり
2. 場所による語り口の違い（MEMOで本音として書くこと vs 外部SNSで見せること）
3. 繰り返し出てくる関心・人・言葉
4. 本人が気づいていなさそうなパターン
5. 読み返す価値のある投稿（本文を短く引用）

---
${lines}`,
      maxTokens: 2500,
    });
    out.innerHTML = `<div class="report-letter">${escapeHtml(text)}</div>`;
  } catch (err) {
    out.innerHTML = `<p class="muted">エラー: ${escapeHtml(err.message)}</p>`;
  }
}

// ---- ダウンロード ----

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ---- イベント ----

function rerender() {
  state.visible = PAGE;
  renderHub();
}

export function initHub() {
  $("#hubSourceChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hub-source]");
    if (!b) return;
    const s = b.dataset.hubSource;
    // 全部ONの状態でタップしたら「そのソースだけ」に絞る。以降はトグル
    if (state.sources.size === Object.keys(SOURCES).length) state.sources = new Set([s]);
    else if (state.sources.has(s)) state.sources.delete(s);
    else state.sources.add(s);
    if (state.sources.size === 0) state.sources = new Set(Object.keys(SOURCES));
    rerender();
  });
  $("#hubText").addEventListener("input", (e) => { state.text = e.target.value.trim().toLowerCase(); rerender(); });
  $("#hubFrom").addEventListener("change", (e) => { state.from = e.target.value; rerender(); });
  $("#hubTo").addEventListener("change", (e) => { state.to = e.target.value; rerender(); });
  $("#hubMineOnly").addEventListener("change", (e) => { state.mineOnly = e.target.checked; rerender(); });
  $("#hubSort").addEventListener("change", (e) => { state.sort = e.target.value; rerender(); });
  $("#hubClearBtn").addEventListener("click", () => {
    Object.assign(state, { sources: new Set(Object.keys(SOURCES)), text: "", from: "", to: "", mineOnly: false });
    $("#hubText").value = "";
    $("#hubFrom").value = "";
    $("#hubTo").value = "";
    rerender();
  });
  $("#hubSubTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hub-sub]");
    if (!b) return;
    state.sub = b.dataset.hubSub;
    renderHub();
  });

  const view = $("#view-hub");
  view.addEventListener("click", (e) => {
    if (e.target.closest("#hubMoreBtn")) {
      state.visible += PAGE;
      renderHub();
      return;
    }
    const word = e.target.closest("[data-hub-word]");
    if (word) {
      state.text = word.dataset.hubWord.toLowerCase();
      $("#hubText").value = word.dataset.hubWord;
      state.sub = "list";
      rerender();
      $("#hubText").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const act = e.target.closest("[data-hub-action]");
    if (!act) return;
    const it = getExternal().find((x) => x.id === act.dataset.id);
    if (!it) return;
    if (act.dataset.hubAction === "delete" && confirm("この取り込み投稿を削除しますか？（元のSNS上の投稿は消えません）")) {
      deleteExternal(it.id);
    }
  });

  $("#hubSaveHandlesBtn").addEventListener("click", () => {
    saveHubSettings({
      myHandles: { x: $("#hubHandleX").value.trim(), "755": $("#hubHandle755").value.trim() },
      syncExternal: $("#hubSyncExternal").checked,
      brewExternal: $("#hubBrewExternal").checked,
    });
    $("#hubImportMsg").textContent = "保存しました";
  });

  $("#hubImportFile").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    let added = 0, updated = 0, failed = 0;
    for (const f of files) {
      try {
        const r = importAuto(await f.text(), { handle: $("#hubHandleX").value.trim() });
        added += r.added;
        updated += r.updated;
      } catch {
        failed++;
      }
    }
    $("#hubImportMsg").textContent = `取り込み: 新規${added}件・更新${updated}件${failed ? `・読めなかったファイル${failed}件` : ""}`;
  });

  $("#hubClearSourceBtn").addEventListener("click", () => {
    const s = $("#hubClearSourceSelect").value;
    const n = getExternal().filter((it) => it.source === s).length;
    if (n === 0) { $("#hubImportMsg").textContent = "対象がありません"; return; }
    if (confirm(`${sourceMeta(s).label}の取り込み投稿${n}件を削除しますか？（元のSNS上の投稿は消えません）`)) clearSource(s);
  });

  $("#hubExportCsvBtn").addEventListener("click", () => download(`memo-hub-${stamp()}.csv`, toCsv(filtered()), "text/csv;charset=utf-8"));
  $("#hubExportJsonBtn").addEventListener("click", () => download(`memo-hub-${stamp()}.json`, toJson(filtered()), "application/json"));
  $("#hubAiBtn").addEventListener("click", () => runAiAnalysis(filtered()));

  onHubChange(() => { if (!$("#view-hub").hidden) renderHub(); });
  initBridge();
}
