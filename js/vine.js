// ブドウの木 — 育成モデルとSVG描画
//
// 成長は「活動日数」（ポストした日の数）で決まる。
// 7日活動すると「発芽」し、電光掲示板（過去の自分のフィードバック）が解禁される。

export const STAGES = [
  { minDays: 0,   name: "種",   emoji: "🌰", desc: "まだ土の中。刻み続けよう。" },
  { minDays: 7,   name: "発芽", emoji: "🌱", desc: "芽が出た。過去の自分が流れ始める。" },
  { minDays: 21,  name: "蔓",   emoji: "🌿", desc: "蔓が伸びていく。記録が絡まり合う。" },
  { minDays: 60,  name: "葉",   emoji: "🍃", desc: "葉が茂る。思考に日が当たる。" },
  { minDays: 180, name: "花",   emoji: "🌸", desc: "花が咲いた。実りは近い。" },
  { minDays: 365, name: "実",   emoji: "🍇", desc: "房が実った。過去は熟成し、いつでも味わえる。" },
];

export function stageOf(activeDays) {
  let stage = STAGES[0];
  let index = 0;
  STAGES.forEach((s, i) => {
    if (activeDays >= s.minDays) { stage = s; index = i; }
  });
  return { ...stage, index };
}

export function nextStage(activeDays) {
  return STAGES.find((s) => s.minDays > activeDays) || null;
}

export function isSprouted(activeDays) {
  return activeDays >= 7;
}

// 房（ふさ）＝ 引用でつながったポストのまとまりの数
export function bunchCount(posts) {
  return posts.filter((p) => (p.quoteCount || 0) > 0).length;
}

// ---- SVG描画 ----
// 活動日数に応じて蔓が伸び、葉と実がつく。決定的（乱数はシード付き）に描く。

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderVineSvg(activeDays, totalPosts, bunches) {
  const W = 360, H = 300;
  const rand = mulberry32(42);
  const parts = [];

  // 土
  parts.push(`<ellipse cx="${W / 2}" cy="${H - 12}" rx="90" ry="10" fill="#2a2237"/>`);

  if (activeDays === 0) {
    parts.push(`<circle cx="${W / 2}" cy="${H - 18}" r="7" fill="#8a6a4a"/>`);
    parts.push(`<text x="${W / 2}" y="${H - 40}" text-anchor="middle" font-size="12" fill="#9a92b5">最初のひと粒を刻もう</text>`);
    return svgWrap(W, H, parts.join(""));
  }

  // 幹の高さ: 活動日数で伸びる（上限あり）
  const growth = Math.min(activeDays / 365, 1); // 0..1
  const trunkH = 40 + growth * 200;
  const baseX = W / 2, baseY = H - 16;

  // 幹（ゆるく蛇行する蔓）
  const segs = 6;
  let d = `M ${baseX} ${baseY}`;
  const pts = [];
  for (let i = 1; i <= segs; i++) {
    const y = baseY - (trunkH * i) / segs;
    const x = baseX + Math.sin(i * 1.7) * (8 + growth * 14);
    pts.push([x, y]);
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  parts.push(`<path d="${d}" stroke="#6a8a5a" stroke-width="${3 + growth * 3}" fill="none" stroke-linecap="round"/>`);

  // 枝: 7日ごとに1本（上限16本）
  const branches = Math.min(Math.floor(activeDays / 7), 16);
  const leaves = Math.min(totalPosts, 60);
  let leafDrawn = 0;

  for (let b = 0; b < branches; b++) {
    const t = (b + 1) / (branches + 1);
    const pi = Math.min(Math.floor(t * pts.length), pts.length - 1);
    const [px, py] = pts[pi];
    const dir = b % 2 === 0 ? 1 : -1;
    const len = 25 + rand() * 35;
    const ex = px + dir * len;
    const ey = py - 6 - rand() * 14;
    parts.push(`<path d="M ${px} ${py} Q ${px + dir * len * 0.6} ${py - 12}, ${ex} ${ey}" stroke="#6a8a5a" stroke-width="2" fill="none"/>`);

    // 葉（ポスト数に応じて枝に散らす）
    const leavesHere = Math.ceil(leaves / branches);
    for (let l = 0; l < leavesHere && leafDrawn < leaves; l++, leafDrawn++) {
      const lt = 0.4 + rand() * 0.6;
      const lx = px + dir * len * lt + (rand() - 0.5) * 10;
      const ly = py - 10 * lt - rand() * 12;
      const r = 4 + rand() * 3;
      parts.push(`<ellipse cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" rx="${r}" ry="${r * 0.6}" fill="#7ec27a" opacity="${0.5 + rand() * 0.5}" transform="rotate(${(rand() * 60 - 30).toFixed(0)} ${lx.toFixed(1)} ${ly.toFixed(1)})"/>`);
    }

    // 房（引用ポストの数だけ、枝の先にブドウ）
    if (b < bunches) {
      const gx = ex, gy = ey + 10;
      for (let g = 0; g < 6; g++) {
        const ang = (g / 6) * Math.PI * 2;
        const rr = g === 0 ? 0 : 5;
        parts.push(`<circle cx="${(gx + Math.cos(ang) * rr).toFixed(1)}" cy="${(gy + 4 + Math.sin(ang) * rr * 0.8 + (g > 2 ? 4 : 0)).toFixed(1)}" r="3.4" fill="#b88ae8" stroke="#8f6ee0" stroke-width=".5"/>`);
      }
    }
  }

  // 発芽前は小さな芽だけ
  if (activeDays < 7) {
    parts.length = 0;
    parts.push(`<ellipse cx="${W / 2}" cy="${H - 12}" rx="90" ry="10" fill="#2a2237"/>`);
    const h = 12 + activeDays * 4;
    parts.push(`<path d="M ${baseX} ${baseY} L ${baseX} ${baseY - h}" stroke="#7ec27a" stroke-width="3" stroke-linecap="round"/>`);
    parts.push(`<ellipse cx="${baseX - 6}" cy="${baseY - h}" rx="7" ry="4" fill="#7ec27a" transform="rotate(-30 ${baseX - 6} ${baseY - h})"/>`);
    parts.push(`<ellipse cx="${baseX + 6}" cy="${baseY - h}" rx="7" ry="4" fill="#7ec27a" transform="rotate(30 ${baseX + 6} ${baseY - h})"/>`);
  }

  return svgWrap(W, H, parts.join(""));
}

function svgWrap(w, h, inner) {
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ブドウの木">${inner}</svg>`;
}
