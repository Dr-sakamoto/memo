#!/usr/bin/env node
// 醸造の材料を取ってくる（ルーティンの1手目）。
//
//   node scripts/routine/brew-fetch.mjs [--out brew-work] [--backfill 0]
//
// 同期された一本の流れ（MEMOの雑記＋外部SNSの自分の投稿）を読み、まだレポートの無い
// 「完了した週・月」ごとに作業ファイル <out>/<期間>.json を書き出す。
//   既定: 直近に完了した週と月だけ。--backfill N でそれより前も最大N期間ずつ遡る。
// 対象が無ければ「NOTHING_PENDING」と出力して終わる。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, weekStartOf, periodOf, brewPool, inRange, formatPosts } from "./lib.mjs";
import { REPORT_SCHEMA, buildCarryOverFrom } from "../../js/schema.js";
import { SYSTEM_PROMPT_TEXT } from "./persona.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = opt("out", "brew-work");
const backfill = Math.max(0, Number(opt("backfill", "0")) || 0);

const state = await rpc("routine_read_state");
const data = state?.data || {};
const reports = data.reports || [];
const done = new Set([...reports.map((r) => r.periodKey), ...(state?.inbox_period_keys || [])]);
const pool = brewPool(data);

const now = new Date();
const candidates = [];
// 週次: 今週の月曜より前に終わった週を、新しい方から
let ws = new Date(weekStartOf(now).getTime() - 7 * 86400000);
for (let i = 0; i <= backfill; i++, ws = new Date(ws.getTime() - 7 * 86400000)) candidates.push(periodOf("weekly", ws));
// 月次: 今月より前に終わった月を、新しい方から
let ms = new Date(now.getFullYear(), now.getMonth() - 1, 1);
for (let i = 0; i <= backfill; i++, ms = new Date(ms.getFullYear(), ms.getMonth() - 1, 1)) candidates.push(periodOf("monthly", ms));

mkdirSync(outDir, { recursive: true });
const written = [];
for (const period of candidates) {
  if (done.has(period.key)) continue;
  const posts = inRange(pool, period.from, period.to);
  if (posts.length === 0) continue;

  // 同じ粒度の直前レポート（持ち越し文脈）
  const prev = reports
    .filter((r) => r.periodType === period.type && new Date(r.from) < period.from)
    .sort((a, b) => new Date(b.from) - new Date(a.from))[0] || null;
  const carry = buildCarryOverFrom(prev);

  const work = {
    period: { ...period, from: period.from.toISOString(), to: period.to.toISOString() },
    postCount: posts.length,
    sources: posts.reduce((acc, p) => ({ ...acc, [p.source]: (acc[p.source] || 0) + 1 }), {}),
    hasPrevious: Boolean(carry),
    carryOverFrom: carry?.report?.periodKey || null,
    postIds: posts.map((p) => p.id),
    persona: SYSTEM_PROMPT_TEXT,
    carryOverText: carry?.text || "",
    postsText: formatPosts(posts),
    schema: REPORT_SCHEMA,
  };
  const file = join(outDir, `${period.key.replace(/[^a-z0-9-]/gi, "_")}.json`);
  writeFileSync(file, JSON.stringify(work, null, 2));
  written.push(`${file}\t${period.label}\t${posts.length}件`);
}

if (written.length === 0) {
  console.log("NOTHING_PENDING");
} else {
  console.log(written.join("\n"));
}
