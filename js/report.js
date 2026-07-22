// レポート — 自由な雑記をAIが「予め決めた分析フォーマット」で構造化する
//
// 入力は構造化しない（雑記のまま）。構造はAIの解釈の側に固定スキーマとして置く。
// 毎回同じスキーマで蓄積されるため、週をまたいだメタ分析（テーマの変遷・
// AI観測の気分スコア推移・盲点の繰り返しパターン）が可能になり、
// どのAIプロバイダにも依存しない汎用データになる。

import { getPosts, getReports, hasReport, addReport, newReportId, getSettings } from "./store.js";
import { runReportWorkflow } from "./workflow.js";

export const REPORT_SCHEMA_VERSION = 1;

// 分析フォーマット（固定スキーマ）
// Anthropicではoutput_configで出力を強制、Geminiではプロンプト+JSONモードで誘導
export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "mood_score", "mood_trend", "mood_evidence",
    "themes", "emotions", "blind_spot", "contradiction",
    "suggestion", "reread_post_ids", "letter",
  ],
  properties: {
    mood_score: { type: "number", description: "期間全体の気分スコア。-2(最悪)〜+2(最高)の実数" },
    mood_trend: { type: "string", enum: ["up", "flat", "down"], description: "期間内での気分の推移方向" },
    mood_evidence: { type: "string", description: "スコアの根拠となった記述の要約" },
    themes: {
      type: "array",
      description: "思考が向かっていた主要テーマ（重要度順に最大5件）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "weight", "summary"],
        properties: {
          name: { type: "string", description: "テーマ名（短く）" },
          weight: { type: "number", description: "占有度 0〜1" },
          summary: { type: "string", description: "このテーマについて本人が考えていたことの要約" },
        },
      },
    },
    emotions: {
      type: "array",
      description: "観測された感情の内訳（最大5件）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "intensity"],
        properties: {
          label: { type: "string", description: "感情の名前（例: 焦り、安堵、好奇心）" },
          intensity: { type: "integer", description: "強度 1〜5" },
        },
      },
    },
    blind_spot: { type: "string", description: "本人が気づいていなさそうな視点。率直に" },
    contradiction: { type: "string", description: "記録内の矛盾や、言動のズレ。なければ空文字" },
    suggestion: {
      type: "object",
      additionalProperties: false,
      required: ["action", "why"],
      properties: {
        action: { type: "string", description: "次の期間に取るべき具体的な行為をひとつ" },
        why: { type: "string", description: "なぜそれが今必要か" },
      },
    },
    reread_post_ids: { type: "array", items: { type: "string" }, description: "いま読み返す価値のあるポストのID（最大3件）" },
    letter: { type: "string", description: "以上を踏まえた、唯一の他者からの手紙（自然な文章、マークダウン見出し不使用）" },
  },
};

// ---- 期間ヘルパー（週は月曜始まり） ----

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function weekStartOf(date) {
  const d = startOfDay(date);
  const day = (d.getDay() + 6) % 7; // 月=0
  d.setDate(d.getDate() - day);
  return d;
}

function fmtYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function periodKeyOf(type, from) {
  return type === "monthly"
    ? `monthly:${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`
    : `weekly:${fmtYmd(from)}`;
}

export function periodLabelOf(type, from, to) {
  if (type === "monthly") return `${from.getFullYear()}年${from.getMonth() + 1}月`;
  const end = new Date(to.getTime() - 1);
  return `${from.getMonth() + 1}/${from.getDate()}〜${end.getMonth() + 1}/${end.getDate()}の週`;
}

function postsInRange(posts, from, to) {
  return posts.filter((p) => {
    const t = new Date(p.createdAt).getTime();
    return t >= from.getTime() && t < to.getTime();
  });
}

// 生成可能な期間 = 「完了した週/月」で、ポストがあり、レポート未作成のもの（新しい順）
export function listGeneratablePeriods(now = new Date()) {
  const posts = getPosts();
  if (posts.length === 0) return [];
  const first = new Date(posts[posts.length - 1].createdAt);
  const out = [];

  // 週次: 今週の月曜より前に終わった週
  const thisWeekStart = weekStartOf(now);
  for (let ws = weekStartOf(first); ws < thisWeekStart; ws = new Date(ws.getTime() + 7 * 86400000)) {
    const we = new Date(ws.getTime() + 7 * 86400000);
    const inRange = postsInRange(posts, ws, we);
    if (inRange.length === 0) continue;
    const key = periodKeyOf("weekly", ws);
    if (hasReport(key)) continue;
    out.push({ type: "weekly", from: ws, to: we, key, label: periodLabelOf("weekly", ws, we), count: inRange.length });
  }

  // 月次: 今月より前に終わった月
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let ms = new Date(first.getFullYear(), first.getMonth(), 1); ms < thisMonthStart; ms = new Date(ms.getFullYear(), ms.getMonth() + 1, 1)) {
    const me = new Date(ms.getFullYear(), ms.getMonth() + 1, 1);
    const inRange = postsInRange(posts, ms, me);
    if (inRange.length === 0) continue;
    const key = periodKeyOf("monthly", ms);
    if (hasReport(key)) continue;
    out.push({ type: "monthly", from: ms, to: me, key, label: periodLabelOf("monthly", ms, me), count: inRange.length });
  }

  return out.sort((a, b) => b.from - a.from);
}

// 直近の未作成週次レポート（バナー表示用）
export function pendingWeekly(now = new Date()) {
  return listGeneratablePeriods(now).find((p) => p.type === "weekly") || null;
}

// ---- 生成 ----
//
// 実際の整形アルゴリズム（正規化→抽出→統合→照合の多段パイプライン）は workflow.js に
// 内包されており、無造作な雑記ログを毎回この固定スキーマに落とし込む。ここはドメインの
// スキーマを注入してワークフローを回し、来歴（pipeline）付きでレポートを保存するだけ。

export async function generateReport(period, { onProgress } = {}) {
  const posts = postsInRange(getPosts(), period.from, period.to);
  if (posts.length === 0) throw new Error("この期間のポストがありません");

  const s = getSettings();
  const { data, pipeline } = await runReportWorkflow(period, posts, {
    schema: REPORT_SCHEMA,
    onProgress,
  });

  const report = {
    id: newReportId(),
    schemaVersion: REPORT_SCHEMA_VERSION,
    periodKey: period.key,
    periodType: period.type,
    periodLabel: period.label,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    postCount: posts.length,
    provider: s.provider,
    model: s.provider === "gemini" ? s.geminiModel : s.anthropicModel,
    createdAt: new Date().toISOString(),
    pipeline, // 生成の来歴（mode / chunks / units / requests / topics）
    data,
  };
  addReport(report);
  return report;
}

// ---- メタ分析（レポート横断） ----

export function reportTimeSeries() {
  return getReports()
    .slice()
    .sort((a, b) => new Date(a.from) - new Date(b.from))
    .map((r) => ({
      label: r.periodLabel,
      type: r.periodType,
      mood: r.data.mood_score,
      trend: r.data.mood_trend,
      themes: (r.data.themes || []).map((t) => t.name),
    }));
}

export function recurringThemes(minCount = 2) {
  const count = {};
  getReports().forEach((r) => {
    (r.data.themes || []).forEach((t) => { count[t.name] = (count[t.name] || 0) + 1; });
  });
  return Object.entries(count)
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1]);
}
