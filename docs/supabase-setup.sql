-- ============================================================
-- MEMO クラウド同期 — Supabase セットアップ
-- ============================================================
-- スマホ⇔パソコンで雑記＋レポートを同期するための、あなた専用の
-- データ置き場を用意します。所要 5 分・無料枠で十分です。
--
-- 【手順】
-- 1. https://supabase.com/ で無料プロジェクトを1つ作る
-- 2. 左メニュー「SQL Editor」を開き、このファイルの中身を貼り付けて Run
-- 3. 「Authentication → Sign In / Providers → Email」で
--      "Confirm email"（メール確認）を OFF にする
--      → パスワードだけで即ログインできるようになります（個人利用向け）
--      ※ OFF にしない場合は、初回サインアップ後に確認メールのリンクを
--        開いてからログインしてください。
-- 4. 「Project Settings → Data API」で Project URL を、
--    「Project Settings → API Keys」で anon (publishable) key を控える
-- 5. アプリの「設定 → ☁️ クラウド同期 → 接続先の設定」に URL と公開キーを入力
-- 6. 両方の端末（スマホ・PC）で同じメール/パスワードでログインすれば同期完了
--
-- ※ anon(公開)キーはクライアントに埋め込まれる前提の公開情報です。
--   下記の Row Level Security により、ログインした本人の1行しか
--   読み書きできないため、公開しても他人のデータは覗けません。
-- ============================================================

-- ユーザーごとに1行。data に雑記＋レポートの JSON をまるごと保存する。
create table if not exists public.memo_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row Level Security: 自分の行だけを読み書きできるようにする。
alter table public.memo_state enable row level security;

drop policy if exists "memo_state_select_own" on public.memo_state;
create policy "memo_state_select_own"
  on public.memo_state for select
  using (auth.uid() = user_id);

drop policy if exists "memo_state_insert_own" on public.memo_state;
create policy "memo_state_insert_own"
  on public.memo_state for insert
  with check (auth.uid() = user_id);

drop policy if exists "memo_state_update_own" on public.memo_state;
create policy "memo_state_update_own"
  on public.memo_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
