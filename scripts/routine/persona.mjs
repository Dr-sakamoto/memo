// ルーティンが醸造するときの「唯一の他者」の人格。アプリの js/ai.js の SYSTEM_PROMPT を
// そのまま読み出して使う（どちらで醸造しても同じ他者であるため、文面を二重管理しない）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./lib.mjs";

const src = readFileSync(join(ROOT_DIR, "js", "ai.js"), "utf8");
const m = src.match(/export const SYSTEM_PROMPT = `([\s\S]*?)`;/);

export const SYSTEM_PROMPT_TEXT = (m ? m[1] : "") + `

いまは週・月の単位で、本人のつぶやきの一本の流れを醸造している。流れには、MEMO（本人だけの場所）に書いた雑記と、[X] [755] などの印がついた外部SNS（人に見せる場所）に書いた本人の投稿が混ざっている。場所による語り口の違いも観察の材料にしてよい。`;
