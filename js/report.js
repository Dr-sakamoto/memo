// レポート — 自由な雑記をAIが「予め決めた分析フォーマット」で構造化する
//
// 入力は構造化しない（雑記のまま）。構造はAIの解釈の側に固定スキーマとして置く。
// 毎回同じスキーマで蓄積されるため、週をまたいだメタ分析（テーマの変遷・
// AI観測の気分スコア推移・盲点の繰り返しパターン）が可能になり、
// どのAIプロバイダにも依存しない汎用データになる。

import { getPosts, getReports, hasReport, addReport, newReportId, getSettings } from "./store.js";
import { runReportWorkflow, runRollupWorkflow } from "./workflow.js";

// スキーマ版数。1 = 初版 / 2 = 前回の一手の追跡（previous_action_review）と
// 持ち越し宿題（open_loops）を追加。既存のv1レポートはlocalStorageにそのまま残るため、
// 表示側（app.js）は schemaVersion を見て新セクションの描画を分岐する。
export const REPORT_SCHEMA_VERSION = 2;

// 分析フォーマット（固定スキーマ）
// Anthropicではoutput_configで出力を強制、Geminiではプロンプト+JSONモードで誘導
export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "mood_score", "mood_trend", "mood_evidence",
    "themes", "emotions", "blind_spot", "contradiction",
    "suggestion", "previous_action_review", "open_loops",
    "reread_post_ids", "letter",
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
    previous_action_review: {
      type: "object",
      additionalProperties: false,
      required: ["status", "evidence"],
      description: "前回レポートで提案した『次の一手』の実行状況。前回レポートが無い場合は status を \"unknown\"、evidence を空文字にすること",
      properties: {
        status: {
          type: "string",
          enum: ["done", "partial", "not_done", "unknown"],
          description: "前回の一手を今期の記録から見て実行できていたか。done=実行された / partial=部分的 / not_done=手つかず / unknown=前回レポートが無い、または判断材料が記録に無い。忖度せず率直に",
        },
        evidence: {
          type: "string",
          description: "その判定の根拠になった今期の記述を1〜2文で。前回レポートが無い場合や根拠が無い場合は空文字",
        },
      },
    },
    open_loops: {
      type: "array",
      description: "未解決のまま持ち越されている宿題・保留中の決定（最大5件）。解決済みのものは載せない。該当が無ければ空配列",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "note"],
        properties: {
          label: { type: "string", description: "宿題・保留中の決定を短く（20字程度）" },
          note: { type: "string", description: "なぜ未解決なのか／いつから持ち越されているか" },
        },
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

function quarterOf(date) {
  return Math.floor(date.getMonth() / 3) + 1;
}

export function periodKeyOf(type, from) {
  if (type === "monthly") return `monthly:${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`;
  if (type === "quarterly") return `quarterly:${from.getFullYear()}-Q${quarterOf(from)}`;
  if (type === "yearly") return `yearly:${from.getFullYear()}`;
  return `weekly:${fmtYmd(from)}`;
}

export function periodLabelOf(type, from, to) {
  if (type === "monthly") return `${from.getFullYear()}年${from.getMonth() + 1}月`;
  if (type === "quarterly") return `${from.getFullYear()}年Q${quarterOf(from)}`;
  if (type === "yearly") return `${from.getFullYear()}年`;
  const end = new Date(to.getTime() - 1);
  return `${from.getMonth() + 1}/${from.getDate()}〜${end.getMonth() + 1}/${end.getDate()}の週`;
}

function postsInRange(posts, from, to) {
  return posts.filter((p) => {
    const t = new Date(p.createdAt).getTime();
    return t >= from.getTime() && t < to.getTime();
  });
}

function reportsInRange(reports, from, to) {
  return reports.filter((r) => {
    const t = new Date(r.from).getTime();
    return t >= from.getTime() && t < to.getTime();
  });
}

// ロールアップ（四半期・年次）の入力対象。ロールアップ自身は入れ子にしない
// （週・月の一次観測だけを「観測ユニット」相当として上位のreduceに渡す）。
function rollupSourceReports() {
  return getReports().filter((r) => r.periodType === "weekly" || r.periodType === "monthly");
}

function quarterStartOf(date) {
  const d = startOfDay(date);
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
}

function yearStartOf(date) {
  return new Date(startOfDay(date).getFullYear(), 0, 1);
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

  // ロールアップ（四半期・年次）: 週次・月次とは別の入力（reports）・別の完了条件で判定する。
  // 対象期間内に週次/月次レポートが2件以上なければ「熟成」させる材料が無いのでスキップ。
  const sourceReports = rollupSourceReports();
  if (sourceReports.length) {
    const firstReportFrom = sourceReports
      .map((r) => new Date(r.from))
      .sort((a, b) => a - b)[0];

    const thisQuarterStart = quarterStartOf(now);
    for (let qs = quarterStartOf(firstReportFrom); qs < thisQuarterStart; qs = new Date(qs.getFullYear(), qs.getMonth() + 3, 1)) {
      const qe = new Date(qs.getFullYear(), qs.getMonth() + 3, 1);
      const inRange = reportsInRange(sourceReports, qs, qe);
      if (inRange.length < 2) continue;
      const key = periodKeyOf("quarterly", qs);
      if (hasReport(key)) continue;
      out.push({ type: "quarterly", from: qs, to: qe, key, label: periodLabelOf("quarterly", qs, qe), count: inRange.length });
    }

    const thisYearStart = yearStartOf(now);
    for (let ys = yearStartOf(firstReportFrom); ys < thisYearStart; ys = new Date(ys.getFullYear() + 1, 0, 1)) {
      const ye = new Date(ys.getFullYear() + 1, 0, 1);
      const inRange = reportsInRange(sourceReports, ys, ye);
      if (inRange.length < 2) continue;
      const key = periodKeyOf("yearly", ys);
      if (hasReport(key)) continue;
      out.push({ type: "yearly", from: ys, to: ye, key, label: periodLabelOf("yearly", ys, ye), count: inRange.length });
    }
  }

  return out.sort((a, b) => b.from - a.from);
}

// 直近の未作成週次レポート（バナー表示用）
export function pendingWeekly(now = new Date()) {
  return listGeneratablePeriods(now).find((p) => p.type === "weekly") || null;
}

// ---- 持ち越し文脈（レポートに記憶を持たせる） ----
//
// レポートが互いを読まないと、AIの出す「次の一手」は誰にも追跡されない開ループになる。
// 同じ粒度（週次なら週次）の直近レポートから suggestion と open_loops を取り出して
// 次回の生成プロンプトに差し込み、「先週言われたことをやったか」を毎回判定させて閉じる。

// この期間の直前にあたる、同じ periodType のレポート1件
function previousReportOf(period) {
  return getReports()
    .filter((r) => r.periodType === period.type && new Date(r.from) < period.from)
    .sort((a, b) => new Date(b.from) - new Date(a.from))[0] || null;
}

const VERDICT_LABEL = { agree: "納得する", disagree: "反論する", hold: "保留" };

// 直近レポートを短いテキストブロックにする。差し込む材料が無ければ null。
export function buildCarryOver(period) {
  const prev = previousReportOf(period);
  if (!prev) return null;
  const d = prev.data || {};
  const action = (d.suggestion?.action || "").trim();
  const why = (d.suggestion?.why || "").trim();
  const loops = (Array.isArray(d.open_loops) ? d.open_loops : [])
    .filter((o) => o && String(o.label || "").trim())
    .slice(0, 5);
  const blindSpot = String(d.blind_spot || "").trim();
  const feedback = prev.feedback?.blindSpot;
  const feedbackVerdict = feedback && VERDICT_LABEL[feedback.verdict] ? feedback.verdict : null;
  if (!action && loops.length === 0 && !(blindSpot && feedbackVerdict)) return null; // 判定の材料が無い（＝前回無しと同じ扱い）

  const lines = [`【持ち越し文脈 — 前回の続きとして読むこと】`];
  lines.push(`前回（${prev.periodLabel}）、他者としてのあなたはこう提案した。`);
  if (action) {
    lines.push(`- 次の一手: ${action}`);
    if (why) lines.push(`  （そう言った理由: ${why}）`);
  }
  if (loops.length) {
    lines.push(`- そのとき持ち越しになっていた宿題:`);
    loops.forEach((o) => {
      const note = String(o.note || "").trim();
      lines.push(`  ・${String(o.label).trim()}${note ? `（${note}）` : ""}`);
    });
  }
  lines.push("");
  lines.push(`今期の記録の中に、この一手が実行された／されなかった証跡があるか率直に判定し、previous_action_review に書くこと。忖度も過大評価もしない。記録に証跡が見当たらないなら status は "unknown" でよい。`);
  lines.push(`上の宿題のうち今期も未解決のまま残っているものと、今期あらたに宙に浮いた決定を open_loops に引き継ぐこと。片づいたものは落とす。`);

  if (blindSpot && feedbackVerdict) {
    lines.push("");
    lines.push(`前回、他者としてのあなたはこの盲点を指摘した: 「${blindSpot}」`);
    lines.push(`本人はそれに「${VERDICT_LABEL[feedbackVerdict]}」と応答した${feedback.note ? `（一言: ${String(feedback.note).trim()}）` : ""}。`);
    lines.push(`今期の記録はその応答を裏づけているか、それとも覆しているか率直に見て、今回の blind_spot / contradiction に反映すること。反論されたからといって指摘を弱めず、記録が指摘を裏づけているならそのまま言い切ること。`);
  }

  return { text: lines.join("\n"), report: prev };
}

// ---- schemaVersion 2 フィールドの後処理 ----
//
// workflow.js の reconcile() はドメイン非依存を保つ設計なので、このスキーマ固有の
// 正規化はワークフロー側には置かず、ここで最終結果に当てる。

const REVIEW_STATUSES = ["done", "partial", "not_done", "unknown"];

export function finalizeCarryOverFields(data, { hasPrevious = false } = {}) {
  const pr = data.previous_action_review;
  let status = pr && REVIEW_STATUSES.includes(pr.status) ? pr.status : "unknown";
  let evidence = pr && typeof pr.evidence === "string" ? pr.evidence.trim() : "";
  // 前回レポートが無い期間で done/not_done を名乗らせない（追跡対象が存在しない）
  if (!hasPrevious) {
    status = "unknown";
    evidence = "";
  }
  data.previous_action_review = { status, evidence };

  data.open_loops = (Array.isArray(data.open_loops) ? data.open_loops : [])
    .map((o) => ({
      label: String(o?.label ?? "").trim(),
      note: String(o?.note ?? "").trim(),
    }))
    .filter((o) => o.label)
    .slice(0, 5);
  return data;
}

// ---- 生成 ----
//
// 実際の整形アルゴリズム（正規化→抽出→統合→照合の多段パイプライン）は workflow.js に
// 内包されており、無造作な雑記ログを毎回この固定スキーマに落とし込む。ここはドメインの
// スキーマを注入してワークフローを回し、来歴（pipeline）付きでレポートを保存するだけ。

const ROLLUP_TYPES = ["quarterly", "yearly"];

export async function generateReport(period, { onProgress } = {}) {
  const isRollup = ROLLUP_TYPES.includes(period.type);
  const s = getSettings();
  const carryOver = buildCarryOver(period);

  let data, pipeline, postCount, reportCount;
  if (isRollup) {
    const reports = reportsInRange(rollupSourceReports(), period.from, period.to);
    if (reports.length < 2) throw new Error("この期間の対象レポートが不足しています（週次・月次が2件以上必要）");
    const built = await runRollupWorkflow(period, reports, {
      schema: REPORT_SCHEMA,
      carryOver: carryOver?.text || "",
      onProgress,
    });
    data = built.data;
    pipeline = built.pipeline;
    reportCount = reports.length;
    postCount = reports.reduce((sum, r) => sum + (r.postCount || 0), 0);
  } else {
    const posts = postsInRange(getPosts(), period.from, period.to);
    if (posts.length === 0) throw new Error("この期間のポストがありません");
    const built = await runReportWorkflow(period, posts, {
      schema: REPORT_SCHEMA,
      carryOver: carryOver?.text || "",
      onProgress,
    });
    data = built.data;
    pipeline = built.pipeline;
    postCount = posts.length;
  }
  finalizeCarryOverFields(data, { hasPrevious: Boolean(carryOver) });

  const report = {
    id: newReportId(),
    schemaVersion: REPORT_SCHEMA_VERSION,
    periodKey: period.key,
    periodType: period.type,
    periodLabel: period.label,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    postCount,
    ...(isRollup ? { reportCount } : {}),
    provider: s.provider,
    model: s.provider === "gemini" ? s.geminiModel : s.anthropicModel,
    createdAt: new Date().toISOString(),
    // 生成の来歴（mode / chunks / units / requests / topics）＋どのレポートを引き継いだか
    pipeline: { ...pipeline, carryOverFrom: carryOver?.report.periodKey || null },
    data,
  };
  addReport(report);
  return report;
}

// ---- メタ分析（レポート横断） ----

// periodType（weekly/monthly）ごとにグループ化して返す。
// 呼び出し側で全グループを1本の折れ線に混ぜないこと（粒度の違う点を繋ぐと解釈不能になる —
// かつてのバグがこれで、週次の点の間に月次の点が刺さっていた）。
export function reportTimeSeries() {
  const reports = getReports()
    .filter((r) => !ROLLUP_TYPES.includes(r.periodType)) // ロールアップは週・月と粒度が違うので同じ軸に乗せない
    .slice()
    .sort((a, b) => new Date(a.from) - new Date(b.from));

  const groups = new Map();
  reports.forEach((r) => {
    if (!groups.has(r.periodType)) groups.set(r.periodType, []);
    groups.get(r.periodType).push({
      label: r.periodLabel,
      type: r.periodType,
      mood: r.data.mood_score,
      trend: r.data.mood_trend,
      themes: (r.data.themes || []).map((t) => t.name),
    });
  });
  return Array.from(groups.entries()).map(([type, series]) => ({ type, series }));
}

// 提案の実行率 — 開ループが閉じているかの指標。
// 追跡フィールドを持つ schemaVersion 2 以降のレポートだけを対象にする（v1は判定不能）。
export function suggestionFollowThrough() {
  const tracked = getReports().filter((r) => (r.schemaVersion || 1) >= 2);
  const count = { done: 0, partial: 0, not_done: 0, unknown: 0 };
  tracked.forEach((r) => {
    const st = r.data?.previous_action_review?.status;
    count[REVIEW_STATUSES.includes(st) ? st : "unknown"] += 1;
  });
  const judged = count.done + count.partial + count.not_done;
  return {
    total: tracked.length,
    judged,
    ...count,
    rate: judged ? count.done / judged : null, // 完全実行のみを分子にする
  };
}

// 自己申告の気分（post.mood）と、AIが観測した気分（report.data.mood_score）を
// レポート単位で突き合わせる。「自己認識と他者観測のズレ」を見るための材料。
// 新たなAPI呼び出しは不要（両方とも既存データから求まる）。
export function selfReportedMoodByPeriod() {
  const posts = getPosts();
  return getReports()
    .filter((r) => !ROLLUP_TYPES.includes(r.periodType)) // ロールアップは同じ軸に混ぜない
    .slice()
    .sort((a, b) => new Date(a.from) - new Date(b.from))
    .map((r) => {
      const moods = postsInRange(posts, new Date(r.from), new Date(r.to))
        .map((p) => p.mood)
        .filter((m) => m != null);
      const selfMood = moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null;
      return {
        periodKey: r.periodKey,
        periodType: r.periodType,
        label: r.periodLabel,
        from: r.from,
        selfMood,
        aiMood: r.data.mood_score,
      };
    });
}

// テーマのライフサイクル — 出現回数を数えるだけでは「歴史の熟成」は見えない。
// 各テーマの初出/最終出現の期間と、現在も生きているか（＝一番新しいレポートにも
// 出ているか）を出すことで、「生きているテーマ」と「消えたテーマ」を分けて見せる。
export function themeLifecycles(minCount = 2) {
  const reports = getReports().slice().sort((a, b) => new Date(a.from) - new Date(b.from));
  if (reports.length === 0) return [];
  const latestFrom = reports[reports.length - 1].from;

  const byName = new Map();
  reports.forEach((r) => {
    (r.data.themes || []).forEach((t) => {
      if (!t?.name) return;
      if (!byName.has(t.name)) {
        byName.set(t.name, { name: t.name, count: 0, firstLabel: r.periodLabel, lastLabel: r.periodLabel, lastFrom: r.from });
      }
      const e = byName.get(t.name);
      e.count += 1;
      e.lastLabel = r.periodLabel;
      e.lastFrom = r.from;
    });
  });

  return Array.from(byName.values())
    .filter((e) => e.count >= minCount)
    .map((e) => ({ ...e, active: e.lastFrom === latestFrom }))
    .sort((a, b) => b.count - a.count);
}

// ---- 盲点の繰り返し検出（外部ライブラリなし、日本語のまま比較） ----
//
// 完全一致は期待できないので、記号・空白を除去したうえでbi-gramのJaccard係数を取る。
// 閾値以上のものを同じクラスタにまとめ、複数レポートにまたがって出ているものを
// 「繰り返し指摘されている盲点」として提示する。これは熟成ではなく停滞のサイン。

function normalizeForCompare(s) {
  return String(s || "")
    .replace(/[\s　]/g, "")
    .replace(/[!-/:-@[-`{-~。、！？「」『』（）・〜…\.]/g, "");
}

function bigramSet(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  a.forEach((x) => { if (b.has(x)) inter += 1; });
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export function recurringBlindSpots(threshold = 0.5) {
  const items = getReports()
    .filter((r) => String(r.data?.blind_spot || "").trim())
    .slice()
    .sort((a, b) => new Date(a.from) - new Date(b.from))
    .map((r) => {
      const text = String(r.data.blind_spot).trim();
      return { label: r.periodLabel, from: r.from, text, bg: bigramSet(normalizeForCompare(text)) };
    });

  const used = new Array(items.length).fill(false);
  const clusters = [];
  for (let i = 0; i < items.length; i += 1) {
    if (used[i]) continue;
    const cluster = [items[i]];
    for (let j = i + 1; j < items.length; j += 1) {
      if (used[j]) continue;
      if (jaccard(items[i].bg, items[j].bg) >= threshold) {
        cluster.push(items[j]);
        used[j] = true;
      }
    }
    if (cluster.length >= 2) {
      used[i] = true;
      clusters.push(cluster);
    }
  }

  return clusters
    .map((c) => ({
      text: c[c.length - 1].text, // 最新の言い回しを代表にする
      count: c.length,
      labels: c.map((m) => m.label),
    }))
    .sort((a, b) => b.count - a.count);
}
