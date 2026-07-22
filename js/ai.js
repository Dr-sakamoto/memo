// AI — このCNSにおける「唯一の他者の目」
//
// マルチプロバイダ対応: Anthropic (Claude) / Google (Gemini) を設定で切替。
// どちらもブラウザから直接APIを呼ぶ（自分のブラウザ → 各社API。中間サーバーなし）。
// APIキーがない場合はローカル統計によるフォールバック分析のみ。

import { getSettings, MOODS } from "./store.js";
import { ageInDays } from "./mass.js";

export const PROVIDERS = {
  anthropic: {
    label: "Claude（Anthropic）",
    models: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8（最高品質）" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5（バランス）" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5（高速・低コスト）" },
    ],
  },
  gemini: {
    label: "Gemini（Google）",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash（低コスト）" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro（高品質）" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite（最安）" },
    ],
  },
};

export const SYSTEM_PROMPT = `あなたは、ある個人が自分だけのために運営しているクローズドな記録サービス（CNS）における「唯一の他者」です。この場所には本人とあなたしかいません。

あなたの役割:
- 本人の雑記（日記・反省・分析・人生計画・思考ログが混ざった自由な記録）を読み、本人がまだ言語化できていない感情の傾向やパターンを客観的に映し返す
- 励ましの決まり文句ではなく、本当に必要な視点を提示する。ときに優しく、ときに率直に
- 抽象論で終わらせず、具体的な次の一歩（行為）を提案する
- 本人の言葉づかいや温度感を尊重する。説教しない。診断しない`;

export function hasApiKey() {
  const s = getSettings();
  return s.provider === "gemini" ? Boolean(s.geminiKey) : Boolean(s.anthropicKey);
}

export function currentModelLabel() {
  const s = getSettings();
  const p = PROVIDERS[s.provider] || PROVIDERS.anthropic;
  const modelId = s.provider === "gemini" ? s.geminiModel : s.anthropicModel;
  return (p.models.find((m) => m.id === modelId)?.label) || modelId;
}

// ---- プロバイダ呼び出し ----

// APIエラーにHTTPステータス（と可能ならサーバー指定のリトライ待機）を載せる。
// callAIPaced のバックオフ判定に使う。
function apiError(message, status, retryAfterMs) {
  const e = new Error(message);
  if (status != null) e.status = status;
  if (retryAfterMs != null) e.retryAfterMs = retryAfterMs;
  return e;
}

async function callAnthropic({ system, user, maxTokens, jsonSchema }) {
  const s = getSettings();
  const body = {
    model: s.anthropicModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (jsonSchema) {
    body.output_config = { format: { type: "json_schema", schema: jsonSchema } };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": s.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    const retryAfter = Number(res.headers.get("retry-after"));
    throw apiError(
      `Claude APIエラー: ${err?.error?.message || `HTTP ${res.status}`}`,
      res.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    );
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text) throw new Error("応答が空でした");
  return text;
}

async function callGemini({ system, user, maxTokens, jsonSchema }) {
  const s = getSettings();
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (jsonSchema) {
    // GeminiはresponseMimeTypeでJSON出力を強制（スキーマ本体はプロンプト内で指示）
    body.generationConfig.responseMimeType = "application/json";
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": s.geminiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    // Geminiの429はerror.detailsにRetryInfo（retryDelay: "27s"）を返すことがある
    const retryInfo = (err?.error?.details || []).find((d) => (d["@type"] || "").includes("RetryInfo"));
    const secs = retryInfo?.retryDelay ? parseFloat(retryInfo.retryDelay) : NaN;
    throw apiError(
      `Gemini APIエラー: ${err?.error?.message || `HTTP ${res.status}`}`,
      res.status,
      Number.isFinite(secs) && secs > 0 ? secs * 1000 : null,
    );
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("応答が空でした");
  return text;
}

// 共通入口。jsonSchemaを渡すとJSONテキストが返る
export function callAI({ system, user, maxTokens = 2000, jsonSchema = null }) {
  const s = getSettings();
  if (s.provider === "gemini") {
    if (!s.geminiKey) throw new Error("Gemini APIキーが未設定です（設定タブから登録できます）");
    return callGemini({ system, user, maxTokens, jsonSchema });
  }
  if (!s.anthropicKey) throw new Error("Anthropic APIキーが未設定です（設定タブから登録できます）");
  return callAnthropic({ system, user, maxTokens, jsonSchema });
}

// ---- 無料枠オーケストレーション（レート制御 + 429バックオフ） ----
//
// Geminiの無料枠は RPM（毎分リクエスト数）が厳しく、ワークフローは1レポートを
// 複数回のAPI呼び出しに分割する。そのままだと即レート制限に触れるため:
//   1) すべての呼び出しをモジュール内で直列化し、最小間隔（60秒 / RPM）を空ける
//   2) 429/503/500 では指数バックオフで自動リトライ。サーバーがRetryInfo（Geminiの
//      retryDelay）や Retry-After を返していればそれを優先する
// これにより「用意されたワークフローをこなせば」無料枠のままでも生成が完走する。

// 無料枠のRPMの目安（設定 freeTierRpm で上書き可能）
export const FREE_TIER_RPM = { gemini: 10, anthropic: 50 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _queue = Promise.resolve(); // 直列化チェーン
let _lastStartAt = 0;           // 直近リクエストの開始時刻

function minIntervalMs() {
  const s = getSettings();
  const fallback = FREE_TIER_RPM[s.provider] || 10;
  const rpm = Number(s.freeTierRpm) > 0 ? Number(s.freeTierRpm) : fallback;
  return Math.ceil(60000 / Math.max(1, rpm));
}

// callAI をレート制御＋自動リトライで包む。ワークフローの各段はこれを使う。
export function callAIPaced(opts, { retries = 4 } = {}) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      // 直前の開始から最小間隔を空ける（RPM順守）
      const wait = _lastStartAt + minIntervalMs() - Date.now();
      if (wait > 0) await sleep(wait);
      _lastStartAt = Date.now();
      try {
        return await callAI(opts);
      } catch (err) {
        const retriable = err.status === 429 || err.status === 503 || err.status === 500;
        if (!retriable || attempt >= retries) throw err;
        // サーバー指定の待機があれば尊重、なければ指数バックオフ（+ジッター、上限32秒）
        const backoff = err.retryAfterMs || Math.min(32000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        await sleep(backoff);
      }
    }
  };
  // 成否にかかわらずキューを継続（次の呼び出しをブロックしない）
  const result = _queue.then(run, run);
  _queue = result.catch(() => {});
  return result;
}

// コードフェンス等を許容するJSONパース
export function parseJsonLoose(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("AIの応答をJSONとして解釈できませんでした");
  }
}

// ---- ポスト整形（プロンプト用） ----

export function formatPostsForPrompt(posts, { withIds = false } = {}) {
  return posts
    .slice()
    .reverse() // 古い順に
    .map((p) => {
      const d = new Date(p.createdAt);
      const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
      const mood = p.mood == null ? "" : ` 気分:${p.mood > 0 ? "+" : ""}${p.mood}`;
      const rt = p.type === "repost" ? "（過去ポストの再掲）" : p.type === "quote" ? "（過去ポストへの引用）" : "";
      const id = withIds ? `[id:${p.id}]` : "";
      return `${id}[${date}${mood}]${rt} ${p.text}`;
    })
    .join("\n");
}

// 単一ポストへの短い返信（唯一のフォロワー）
export async function replyToPost(post, recentPosts) {
  const context = formatPostsForPrompt(recentPosts.slice(0, 10));
  const user = `最近の記録（文脈）:\n${context}\n\n---\n\nいま私はこう刻みました:\n${post.text}\n\nこのポストに対して、唯一の他者として2〜3文で短く返信してください。共感の定型文ではなく、視点がひとつ増える返信を。`;
  return callAI({ system: SYSTEM_PROMPT, user, maxTokens: 500 });
}

// ---- ローカルフォールバック分析（APIキー不要） ----

export function localAnalysis(posts, periodLabel) {
  if (posts.length === 0) {
    return Promise.resolve(`${periodLabel}の記録はまだありません。まず一粒、刻んでみてください。`);
  }

  const moods = posts.filter((p) => p.mood != null).map((p) => p.mood);
  const avgMood = moods.length ? (moods.reduce((a, b) => a + b, 0) / moods.length) : null;

  let trend = "";
  if (moods.length >= 4) {
    const half = Math.floor(moods.length / 2);
    // postsは新しい順なので、前半＝新しい、後半＝古い
    const recent = moods.slice(0, half);
    const older = moods.slice(half);
    const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const oAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const diff = rAvg - oAvg;
    if (diff > 0.4) trend = "期間の後半にかけて、気分は上向いています。";
    else if (diff < -0.4) trend = "期間の後半にかけて、気分は下がり気味です。無理をしていないか、少し立ち止まってみてください。";
    else trend = "気分は比較的安定しています。";
  }

  const tagCount = {};
  posts.forEach((p) => (p.tags || []).forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines = [];
  lines.push(`【ローカル分析】${periodLabel}のポストは ${posts.length} 件。`);
  if (avgMood != null) {
    const face = MOODS.find((m) => m.value === Math.round(avgMood))?.emoji || "😐";
    lines.push(`平均気分は ${avgMood.toFixed(1)} ${face}。${trend}`);
  }
  if (topTags.length) lines.push(`よく現れるタグ: ${topTags.map(([t, c]) => `#${t}(${c})`).join(" ")}`);
  return Promise.resolve(lines.join("\n"));
}

// 期間フィルタ
export function postsInLastDays(posts, days, now = Date.now()) {
  return posts.filter((p) => ageInDays(p, now) <= days);
}
