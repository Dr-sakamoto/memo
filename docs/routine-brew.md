# 醸造ルーティンの手順書（Claudeのルーティン用）

MEMOでは **採取はアプリ、分析（醸造）はClaudeのルーティン** が担当する。
このファイルは、毎週起動するルーティンがそのまま従う手順書。

## 前提

- このリポジトリ（`Dr-sakamoto/memo`）がチェックアウトされていること。無ければ `git clone https://github.com/Dr-sakamoto/memo` する
- ルーティンの環境に、ネットワークシークレットとして
  ホスト `hpajnjqgqfgqeykdvnlw.supabase.co`・ヘッダ `x-memo-routine-token` で、
  アプリの「設定 → クラウド同期 → 🤖 Claudeのルーティンに醸造を任せる」で発行した連携トークンが登録されていること
  （トークンは「読む」と「受け取り箱にレポートを置く」しかできない。`docs/supabase-routine.sql`）

## 手順

1. **材料を取る**

   ```sh
   node scripts/routine/brew-fetch.mjs --out brew-work
   ```

   - `NOTHING_PENDING` と出たら、醸造すべき期間は無い。**何もせず静かに終了する**（報告不要）
   - それ以外は、作業ファイル（`brew-work/weekly_YYYY-MM-DD.json` など）が期間ごとに1つずつ出る

2. **期間ごとに醸造する**（作業ファイル1つにつき1回）

   作業ファイルの各フィールド:
   - `persona` … あなたの人格（唯一の他者）。これに従う
   - `period.label` / `postCount` / `sources` … 対象期間と件数（`memo` / `x` / `755`）
   - `carryOverText` … 前回レポートからの持ち越し文脈（空なら初回扱い）
   - `postsText` … 一本の流れ（古い順・`[id:...]` 付き。`[X]` などの印は外部SNSに書いた本人の投稿）
   - `schema` … 出力の固定スキーマ（JSON Schema）

   `postsText` を全部読み、`schema` に**厳密に**合う JSON を `brew-work/<同じ名前>.analysis.json` に書く。

   - 日本語で書く。根拠は必ず記録の中に求める（記録に無いことを推測で断定しない）
   - `mood_score` は -2〜+2。`themes` は最大5件（`weight` は 0〜1）
   - `reread_post_ids` は `postsText` に実在する `id` から最大3件
   - `previous_action_review` と `open_loops` は `carryOverText` の指示に従う（空なら status は `unknown`）
   - `letter` はマークダウン見出しを使わない自然な文章。MEMO（本人だけの場所）と外部SNS（人に見せる場所）での語り口の違いに気づいたら触れてよい
   - JSON以外（説明文・コードフェンス）は書かない

3. **届ける**

   ```sh
   node scripts/routine/brew-put.mjs brew-work/<名前>.json brew-work/<名前>.analysis.json --model "<実行中のモデル名>"
   ```

   `DELIVERED ...` と出れば完了。アプリは次の同期で、レポートタブに「🤖 ルーティン」の印つきで取り込む。
   スキーマ違反などで失敗したら、エラー内容に合わせて analysis.json を直して再実行する（最大2回）。

4. **報告**: 届けた期間（例: 「10/26〜11/1の週」）を1〜2行で伝えて終了する。
   雑記の中身は報告に書き写さない（中身はアプリの中だけで読む）。
   `brew-work/` はコミットしない。

## 失敗したとき

- `HTTP 401` / `invalid routine token` … トークンが無効化されたか未登録。何もせず、その旨だけ報告する
- `request blocked` / 接続できない … ネットワーク設定でホストが許可されていない。その旨だけ報告する
- Supabaseのプロジェクトが一時停止中（無料枠で7日間アクセスが無いと停止する）… その旨だけ報告する
