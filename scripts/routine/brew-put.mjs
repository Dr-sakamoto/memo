#!/usr/bin/env node
// 醸造したレポートを届ける（ルーティンの最後の手）。
//
//   node scripts/routine/brew-put.mjs <作業ファイル.json> <分析.json> [--model 名前] [--dry-run]
//
// 分析.json は作業ファイルの schema に沿った JSON（mood_score, themes, ..., letter）。
// アプリと同じ規則で正規化（スコアのクランプ・実在するポストIDへの絞り込み・持ち越し欄の整形）
// してから、受け取り箱（memo_inbox）へ置く。アプリは次の同期でレポートタブに取り込む。

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { rpc } from "./lib.mjs";
import { REPORT_SCHEMA_VERSION, reconcileReportData, finalizeCarryOverFields } from "../../js/schema.js";

const args = process.argv.slice(2);
const [workPath, analysisPath] = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--model");
if (!workPath || !analysisPath) {
  console.error("使い方: brew-put.mjs <作業ファイル.json> <分析.json> [--model 名前] [--dry-run]");
  process.exit(2);
}
const mi = args.indexOf("--model");
const model = mi >= 0 ? args[mi + 1] : "claude-routine";
const dryRun = args.includes("--dry-run");

const work = JSON.parse(readFileSync(workPath, "utf8"));
let raw = readFileSync(analysisPath, "utf8").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
const data = JSON.parse(raw);

reconcileReportData(data, new Set(work.postIds));
finalizeCarryOverFields(data, { hasPrevious: Boolean(work.hasPrevious) });

const report = {
  id: Date.now().toString(36) + randomBytes(3).toString("hex"),
  schemaVersion: REPORT_SCHEMA_VERSION,
  periodKey: work.period.key,
  periodType: work.period.type,
  periodLabel: work.period.label,
  from: work.period.from,
  to: work.period.to,
  postCount: work.postCount,
  provider: "routine",
  model,
  createdAt: new Date().toISOString(),
  pipeline: { mode: "routine", sources: work.sources, carryOverFrom: work.carryOverFrom || null },
  data,
};

if (dryRun) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const id = await rpc("routine_put_report", { report });
  console.log(`DELIVERED ${work.period.key} (${work.period.label}) id=${id}`);
}
