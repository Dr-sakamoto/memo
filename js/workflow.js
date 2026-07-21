// ワークフロー — 無造作な雑記ログを「高精度・汎用のメタ分析データ」に整形する多段パイプライン
//
// 課題: Geminiの無料枠は RPM/RPD が厳しい。無秩序に書き散らした大量の雑記を
// 一撃で読ませると、(1) レート制限に触れる (2) 長文の取りこぼしや要約の粗さで
// 精度が落ちる。そこで処理を「小さく分けて抽出 → まとめて統合」の map-reduce に
// 分解し、各API呼び出しを ai.js の callAIPaced（直列化＋429バックオフ）に通す。
// 用意されたこのワークフローをこなせば、無料枠のままでも安定して、毎回同じ
// 固定スキーマ（＝プロバイダ非依存の汎用データ）のレポートに落とし込める。
//
//   Stage 0 正規化 (ローカル / 無API): 時系列整列・空/重複除去・チャンク分割
//   Stage 1 抽出   (map    / AI)     : 各チャンク → 原子的な「観測ユニット」(根拠ID付き)
//   Stage 2 統合   (reduce / AI)     : 観測ユニット全体 → 呼び出し側の固定スキーマ
//   Stage 3 照合   (ローカル / 無API): スコアのクランプ・IDの実在検証・トピック頻度
//
// スキーマは呼び出し側（report.js）から注入されるため、この層自体はドメイン非依存。

import { callAIPaced, formatPostsForPrompt, parseJsonLoose, SYSTEM_PROMPT } from "./ai.js";
import { getSettings } from "./store.js";

// ---- チューニング定数 ----
const MAX_POSTS_PER_CHUNK = 40;   // 1チャンクの最大ポスト数
const MAX_CHARS_PER_CHUNK = 6000; // 1チャンクの最大文字数（無料枠のトークンにも優しい粒度）
const SINGLE_PASS_MAX = 20;       // これ以下のポスト数なら一括処理（API 1回で済ませる）

// 抽出(map)ステージの出力スキーマ（観測ユニットの配列）
const UNIT_EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: {
      type: "array",
      description: "無造作な記録から抽出した原子的な観測ユニット",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ids", "observation", "topic", "emotion", "valence"],
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "根拠となったポストID（1〜3件）" },
          observation: { type: "string", description: "本人が考えていた/起きていたことの具体的な一事実（脚色しない）" },
          topic: { type: "string", description: "短いトピック名" },
          emotion: { type: "string", description: "その観測での主要な感情（なければ空文字）" },
          valence: { type: "integer", description: "その観測の感情価 -2〜2" },
        },
      },
    },
  },
};

// ---- Stage 0: 正規化（ローカル・無API） ----

// 時系列（古い順）に並べ、空テキストと重複を除去する。
export function normalizePosts(posts) {
  const seen = new Set();
  return posts
    .filter((p) => p && typeof p.text === "string" && p.text.trim().length > 0)
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .filter((p) => {
      const key = p.text.trim().replace(/\s+/g, " ");
      if (seen.has(key)) return false; // 完全重複（再掲の空文リポスト等）を落とす
      seen.add(key);
      return true;
    });
}

// 古い順の配列を、件数と文字数の予算でチャンクに割る。
function chunkPosts(posts) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const p of posts) {
    const len = (p.text || "").length;
    if (cur.length && (cur.length >= MAX_POSTS_PER_CHUNK || chars + len > MAX_CHARS_PER_CHUNK)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---- プロンプト構築 ----

// formatPostsForPrompt は入力を新しい順とみなして古い順に反転する。
// チャンクは古い順なので、反転して渡すことで表示を古い順に揃える。
function renderChunk(chunk) {
  return formatPostsForPrompt(chunk.slice().reverse(), { withIds: true });
}

function buildExtractPrompt(period, chunk, idx, total) {
  return `これは「${period.label}」の雑記の一部（チャンク ${idx}/${total}、${chunk.length}件）です。行頭の[id:...]が各ポストのIDです。

無造作な記録から、あとで全体を統合するための「観測ユニット」を抽出してください。要約せず粒度は原子的に。推測で足さず、書かれていることに忠実に。JSON以外は一切出力しないでください。

出力スキーマ:
{
  "units": [
    {
      "ids": ["根拠ポストID(1〜3件)"],
      "observation": "具体的な一事実・一思考（脚色しない）",
      "topic": "短いトピック名",
      "emotion": "その時の主要な感情（なければ空文字）",
      "valence": -2〜2の整数（その観測の感情価）
    }
  ]
}

---
${renderChunk(chunk)}`;
}

function buildSynthesisPrompt(period, units, topics, schema) {
  const schemaHint = JSON.stringify(schema.properties, null, 1);
  const unitLines = units
    .map((u) => `- (${u.ids.join(",") || "-"}) [${u.topic}|${u.emotion || "-"}|${u.valence >= 0 ? "+" : ""}${u.valence}] ${u.observation}`)
    .join("\n");
  const topicTable = topics.map(([t, c]) => `${t}×${c}`).join(" / ");
  return `以下は「${period.label}」の雑記から抽出した観測ユニット（${units.length}件）です。これらだけを根拠に、全体を客観的な他者として統合し、次のスキーマに厳密に従うJSONだけを返してください。JSON以外は出力しないでください。

トピック頻度（ローカル集計）: ${topicTable || "（なし）"}

スキーマ（各フィールドのdescriptionに従うこと。reread_post_ids は下の観測ユニットの根拠IDの中から選ぶこと）:
${schemaHint}

観測ユニット（括弧内は根拠ポストID / [トピック|感情|感情価]）:
${unitLines}`;
}

// 一括処理（ポストが少ない期間用。抽出と統合を1回のAPI呼び出しで済ませる）
function buildSinglePassPrompt(period, chunk, schema) {
  const schemaHint = JSON.stringify(schema.properties, null, 1);
  return `以下は私の「${period.label}」の雑記（${chunk.length}件）です。行頭の[id:...]は各ポストのIDです。

全体を客観的な他者として読み、次のJSONスキーマに厳密に従った分析を返してください。JSON以外の文字は出力しないでください。

スキーマ（各フィールドのdescriptionに従うこと）:
${schemaHint}

---
${renderChunk(chunk)}`;
}

// ---- Stage 3補助: 抽出結果と最終結果の照合（ローカル・無API） ----

function sanitizeUnits(units, validIds) {
  const out = [];
  for (const u of Array.isArray(units) ? units : []) {
    if (!u || typeof u.observation !== "string" || !u.observation.trim()) continue;
    const ids = Array.isArray(u.ids) ? u.ids.filter((id) => validIds.has(id)) : [];
    let v = Math.round(Number(u.valence));
    if (!Number.isFinite(v)) v = 0;
    v = Math.max(-2, Math.min(2, v));
    out.push({
      ids,
      observation: u.observation.trim(),
      topic: (u.topic == null ? "" : String(u.topic)).trim() || "その他",
      emotion: (u.emotion == null ? "" : String(u.emotion)).trim(),
      valence: v,
    });
  }
  return out;
}

function topicFrequency(units) {
  const count = {};
  units.forEach((u) => { count[u.topic] = (count[u.topic] || 0) + 1; });
  return Object.entries(count).sort((a, b) => b[1] - a[1]);
}

// 統合結果を固定スキーマに寄せて安全化する（AIのブレを吸収）。
function reconcile(data, validIds) {
  if (!data || typeof data.letter !== "string" || !Array.isArray(data.themes)) {
    throw new Error("統合結果が分析フォーマットに合致しませんでした。もう一度お試しください");
  }
  let mood = Number(data.mood_score);
  if (!Number.isFinite(mood)) mood = 0;
  data.mood_score = Math.max(-2, Math.min(2, mood));
  if (!["up", "flat", "down"].includes(data.mood_trend)) data.mood_trend = "flat";
  if (typeof data.mood_evidence !== "string") data.mood_evidence = "";
  data.themes = data.themes.slice(0, 5);
  data.emotions = Array.isArray(data.emotions) ? data.emotions.slice(0, 5) : [];
  if (typeof data.blind_spot !== "string") data.blind_spot = "";
  if (typeof data.contradiction !== "string") data.contradiction = "";
  if (!data.suggestion || typeof data.suggestion !== "object") data.suggestion = { action: "", why: "" };
  data.reread_post_ids = Array.isArray(data.reread_post_ids)
    ? data.reread_post_ids.filter((id) => validIds.has(id)).slice(0, 3)
    : [];
  return data;
}

// ---- オーケストレーション ----

// mode: "auto"（既定・件数で自動判定） | "force"（常に多段） | "single"（常に一括）
function decideMode(clean, chunks) {
  const setting = getSettings().reportWorkflow || "auto";
  if (setting === "single") return "single";
  if (setting === "force") return "map-reduce";
  return clean.length <= SINGLE_PASS_MAX && chunks.length <= 1 ? "single" : "map-reduce";
}

// 期間のポスト群を受け取り、{ data, pipeline } を返す。
// data は schema に沿った構造化結果、pipeline は生成の来歴（メタデータ）。
export async function runReportWorkflow(period, posts, { schema, onProgress = () => {} } = {}) {
  if (!schema || !schema.properties) throw new Error("スキーマが指定されていません");
  const clean = normalizePosts(posts);
  if (clean.length === 0) throw new Error("この期間の有効な雑記がありません");
  const validIds = new Set(clean.map((p) => p.id));
  const chunks = chunkPosts(clean);
  const mode = decideMode(clean, chunks);

  // --- 一括モード（API 1回） ---
  if (mode === "single") {
    onProgress({ stage: "synthesize", done: 0, total: 1 });
    const raw = await callAIPaced({
      system: SYSTEM_PROMPT,
      user: buildSinglePassPrompt(period, clean, schema),
      maxTokens: 4000,
      jsonSchema: schema,
    });
    const data = reconcile(parseJsonLoose(raw), validIds);
    onProgress({ stage: "synthesize", done: 1, total: 1 });
    return {
      data,
      pipeline: { mode: "single", chunks: 1, units: null, requests: 1, topics: [] },
    };
  }

  // --- 多段モード（map-reduce） ---
  // Stage 1: 各チャンクを観測ユニットに分解（map）
  const allUnits = [];
  onProgress({ stage: "extract", done: 0, total: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    const raw = await callAIPaced({
      system: SYSTEM_PROMPT,
      user: buildExtractPrompt(period, chunks[i], i + 1, chunks.length),
      maxTokens: 2600,
      jsonSchema: UNIT_EXTRACT_SCHEMA,
    });
    let units = [];
    try { units = parseJsonLoose(raw).units; } catch { units = []; }
    allUnits.push(...sanitizeUnits(units, validIds));
    onProgress({ stage: "extract", done: i + 1, total: chunks.length });
  }
  if (allUnits.length === 0) {
    throw new Error("観測ユニットを抽出できませんでした。もう一度お試しください");
  }

  // Stage 2: 観測ユニットを固定スキーマへ統合（reduce）
  const topics = topicFrequency(allUnits);
  onProgress({ stage: "synthesize", done: 0, total: 1 });
  const raw = await callAIPaced({
    system: SYSTEM_PROMPT,
    user: buildSynthesisPrompt(period, allUnits, topics, schema),
    maxTokens: 4000,
    jsonSchema: schema,
  });
  const data = reconcile(parseJsonLoose(raw), validIds);
  onProgress({ stage: "synthesize", done: 1, total: 1 });

  return {
    data,
    pipeline: {
      mode: "map-reduce",
      chunks: chunks.length,
      units: allUnits.length,
      requests: chunks.length + 1,
      topics: topics.slice(0, 12),
    },
  };
}
