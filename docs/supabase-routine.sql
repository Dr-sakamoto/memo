-- ============================================================
-- MEMO × Claude ルーティン（醸造の自動化）— Supabase 追加セットアップ
-- ============================================================
-- 採取はアプリ（MEMO＋Chrome拡張）、分析（醸造）は Claude のルーティンが担う。
-- ルーティンが作ったレポートは「受け取り箱（memo_inbox）」に置かれ、
-- アプリが次の同期で取り込んで、レポートタブに通常のレポートとして並べる。
--
-- ルーティンはユーザーとしてログインしない。アプリの設定タブで発行する
-- 「ルーティン連携トークン」だけを持ち、それで次の2つしかできない:
--   1. routine_read_state()      … 自分の memo_state.data を読む（読み取り専用）
--   2. routine_put_report(jsonb) … 受け取り箱にレポートを1件置く
-- memo_state そのものを書き換えることはできない（同期の競合で雑記を失わないため）。
-- トークンはSHA-256のハッシュだけを保存する。アプリで「無効化」すれば即座に使えなくなる。
--
-- 【手順】docs/supabase-setup.sql を実行済みのプロジェクトで、このファイルを SQL Editor で Run。
-- ============================================================

-- ルーティン連携トークン（ユーザーごとに1つ。ハッシュのみ保存）
create table if not exists public.memo_routine_tokens (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  token_hash text        not null,
  created_at timestamptz not null default now()
);
alter table public.memo_routine_tokens enable row level security;

drop policy if exists "routine_tokens_own" on public.memo_routine_tokens;
create policy "routine_tokens_own"
  on public.memo_routine_tokens for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 受け取り箱: ルーティンが置いたレポート。アプリが取り込んだら消す。
create table if not exists public.memo_inbox (
  id         text        primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  kind       text        not null default 'report',
  payload    jsonb       not null,
  created_at timestamptz not null default now()
);
alter table public.memo_inbox enable row level security;

drop policy if exists "inbox_select_own" on public.memo_inbox;
create policy "inbox_select_own"
  on public.memo_inbox for select
  using (auth.uid() = user_id);

drop policy if exists "inbox_delete_own" on public.memo_inbox;
create policy "inbox_delete_own"
  on public.memo_inbox for delete
  using (auth.uid() = user_id);

-- リクエストヘッダ x-memo-routine-token のトークンから、ユーザーを引く
create or replace function public.memo_routine_user()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.user_id
  from public.memo_routine_tokens t
  where t.token_hash = encode(
    sha256(convert_to(coalesce(
      current_setting('request.headers', true)::json ->> 'x-memo-routine-token', ''
    ), 'UTF8')), 'hex')
    and length(coalesce(current_setting('request.headers', true)::json ->> 'x-memo-routine-token', '')) >= 32
  limit 1
$$;

-- 読み取り: 雑記＋レポート＋（同期ONなら）外部投稿と、受け取り箱に置いたままのレポートの期間キー
create or replace function public.routine_read_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := public.memo_routine_user();
begin
  if uid is null then
    raise exception 'invalid routine token' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'data', coalesce((select s.data from public.memo_state s where s.user_id = uid), '{}'::jsonb),
    'inbox_period_keys', coalesce((
      select jsonb_agg(i.payload ->> 'periodKey')
      from public.memo_inbox i where i.user_id = uid and i.kind = 'report'
    ), '[]'::jsonb)
  );
end;
$$;

-- 書き込み: 受け取り箱にレポートを1件置く（同じidは無視）
create or replace function public.routine_put_report(report jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  uid uuid := public.memo_routine_user();
  rid text := report ->> 'id';
begin
  if uid is null then
    raise exception 'invalid routine token' using errcode = '28000';
  end if;
  if rid is null or length(rid) > 100
     or report ->> 'periodKey' is null
     or jsonb_typeof(report -> 'data') is distinct from 'object'
     or octet_length(report::text) > 200000 then
    raise exception 'invalid report payload' using errcode = '22023';
  end if;
  insert into public.memo_inbox (id, user_id, kind, payload)
  values (rid, uid, 'report', report)
  on conflict (id) do nothing;
  return rid;
end;
$$;

revoke all on function public.memo_routine_user() from public, anon, authenticated;
revoke all on function public.routine_read_state() from public;
revoke all on function public.routine_put_report(jsonb) from public;
grant execute on function public.routine_read_state() to anon;
grant execute on function public.routine_put_report(jsonb) to anon;
