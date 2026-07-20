// AI — このCNSにおける「唯一の他者の目」
//
// APIキーがある場合: ブラウザから直接 Anthropic Messages API を呼ぶ
// （anthropic-dangerous-direct-browser-access ヘッダーでCORSを許可。
//   キーは自分のブラウザから api.anthropic.com へ直接送られるだけで、他のサーバーは経由しない）
// APIキーがない場合: ローカル統計によるフォールバック分析

import { getSettings, MOODS } from "./store.js";
import { ageInDays } from "./mass.js";

const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `あなたは、ある個人が自分だけのために運営しているクローズドな記録サービス（CNS）における「唯一の他者」です。この場所には本人とあなたしかいません。

あなたの役割:
- 本人の日記・反省・分析・人生計画・思考ログを読み、本人がまだ言語化できていない感情の傾向やパターンを映し返す
- 励ましの決まり文句ではなく、本当に必要な視点を提示する。ときに優しく、ときに率直に
- 抽象論で終わらせず、具体的な次の一歩（行為）をひとつかふたつ提案する
- 本人の言葉づかいや温度感を尊重する。説教しない。診断しない

出力は日本語で、マークダウンの見出しを使わずに、手紙のような自然な文章で書いてください。`;

function callClaude({ apiKey, model, system, messages, maxTokens = 2000 }) {
  return fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = body?.error?.message || `HTTP ${res.status}`;
      throw new Error(`APIエラー: ${msg}`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text) throw new Error("応答が空でした");
    return text;
  });
}

export function hasApiKey() {
  return Boolean(getSettings().apiKey);
}

function formatPostsForPrompt(posts) {
  return posts
    .slice()
    .reverse() // 古い順に
    .map((p) => {
      const d = new Date(p.createdAt);
      const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
      const mood = p.mood == null ? "" : ` 気分:${p.mood > 0 ? "+" : ""}${p.mood}`;
      const rt = p.type === "repost" ? "（過去ポストの再掲）" : p.type === "quote" ? "（過去ポストへの引用）" : "";
      return `[${date}][${p.kind}${mood}]${rt} ${p.text}`;
    })
    .join("\n");
}

// 期間分析（唯一の他者からの手紙）
export async function analyzePeriod(posts, periodLabel) {
  const { apiKey, model } = getSettings();
  if (!apiKey) return localAnalysis(posts, periodLabel);

  const body = formatPostsForPrompt(posts);
  const user = `以下は私の${periodLabel}の記録です。全体を読んで、(1)感情や思考の傾向、(2)私が気づいていなさそうな視点、(3)いま本当に必要だと思う具体的な行為の提案、を手紙のように書いてください。\n\n---\n${body}`;

  return callClaude({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
  });
}

// 単一ポストへの短い返信（唯一のフォロワー）
export async function replyToPost(post, recentPosts) {
  const { apiKey, model } = getSettings();
  if (!apiKey) throw new Error("APIキーが未設定です（設定タブから登録できます）");

  const context = formatPostsForPrompt(recentPosts.slice(0, 10));
  const user = `最近の記録（文脈）:\n${context}\n\n---\n\nいま私はこう刻みました:\n[${post.kind}] ${post.text}\n\nこのポストに対して、唯一の他者として2〜3文で短く返信してください。共感の定型文ではなく、視点がひとつ増える返信を。`;

  return callClaude({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
    maxTokens: 500,
  });
}

// ---- ローカルフォールバック分析（APIキー不要） ----

export function localAnalysis(posts, periodLabel) {
  if (posts.length === 0) {
    return Promise.resolve(`${periodLabel}の記録はまだありません。まず一粒、刻んでみてください。`);
  }

  const moods = posts.filter((p) => p.mood != null).map((p) => p.mood);
  const avgMood = moods.length ? (moods.reduce((a, b) => a + b, 0) / moods.length) : null;

  // 前半と後半で気分の推移を見る
  let trend = "";
  if (moods.length >= 4) {
    const half = Math.floor(moods.length / 2);
    // postsは新しい順なので、後半＝古い、前半＝新しい
    const recent = moods.slice(0, half);
    const older = moods.slice(half);
    const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const oAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const diff = rAvg - oAvg;
    if (diff > 0.4) trend = "期間の後半にかけて、気分は上向いています。";
    else if (diff < -0.4) trend = "期間の後半にかけて、気分は下がり気味です。無理をしていないか、少し立ち止まってみてください。";
    else trend = "気分は比較的安定しています。";
  }

  const kindCount = {};
  posts.forEach((p) => { kindCount[p.kind] = (kindCount[p.kind] || 0) + 1; });
  const topKind = Object.entries(kindCount).sort((a, b) => b[1] - a[1])[0];

  const tagCount = {};
  posts.forEach((p) => (p.tags || []).forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines = [];
  lines.push(`【ローカル分析】${periodLabel}のポストは ${posts.length} 件。`);
  if (avgMood != null) {
    const face = MOODS.find((m) => m.value === Math.round(avgMood))?.emoji || "😐";
    lines.push(`平均気分は ${avgMood.toFixed(1)} ${face}。${trend}`);
  }
  if (topKind) lines.push(`いちばん多いのは「${topKind[0]}」（${topKind[1]}件）。`);
  if (topTags.length) lines.push(`よく現れるタグ: ${topTags.map(([t, c]) => `#${t}(${c})`).join(" ")}`);
  lines.push("");
  lines.push("※ AIによる深い分析を使うには、設定タブでAnthropic APIキーを登録してください。");
  return Promise.resolve(lines.join("\n"));
}

// 期間フィルタ
export function postsInLastDays(posts, days, now = Date.now()) {
  return posts.filter((p) => ageInDays(p, now) <= days);
}
