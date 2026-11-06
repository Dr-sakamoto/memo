// レポートの固定スキーマ（分析フォーマット）と、その正規化。
// 依存ゼロ・DOM/localStorage非依存。アプリ（js/report.js）と、Claudeのルーティンが使う
// scripts/routine/*.mjs の両方から読み込む＝どちらで醸造しても同じ形のレポートになる。

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


// ---- schemaVersion 2 フィールドの後処理 ----
//
// workflow.js の reconcile() はドメイン非依存を保つ設計なので、このスキーマ固有の
// 正規化はワークフロー側には置かず、ここで最終結果に当てる。

export const REVIEW_STATUSES = ["done", "partial", "not_done", "unknown"];

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

// AIの出力を固定スキーマに寄せて安全化する（js/workflow.js の reconcile と同じ規則）。
// validIds: reread_post_ids として許すポストIDの集合
export function reconcileReportData(data, validIds) {
  if (!data || typeof data.letter !== "string" || !Array.isArray(data.themes)) {
    throw new Error("分析フォーマットに合致しません（letter / themes が必要）");
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

const VERDICT_LABEL = { agree: "納得する", disagree: "反論する", hold: "保留" };

// 持ち越し文脈（前回レポートの「次の一手」「宿題」「盲点への応答」）をプロンプト用テキストにする。
// prev: 同じ粒度の直前のレポート（無ければ null）。返り値 { text, report } または null。
export function buildCarryOverFrom(prev) {
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
