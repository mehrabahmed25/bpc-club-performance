-- Official Matches: separate records, seasons, and page-specific editor permission.
-- Run this migration in Supabase SQL Editor before using the new page.
create table if not exists public.official_seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  start_date date not null,
  end_date date not null,
  is_closed boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint official_seasons_valid_dates check (end_date >= start_date)
);
create table if not exists public.official_matches (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete restrict,
  match_date date not null,
  goals_for integer not null check (goals_for >= 0 and goals_for <= 99),
  goals_against integer not null check (goals_against >= 0 and goals_against <= 99),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists official_matches_player_date_idx on public.official_matches(player_id, match_date);
create index if not exists official_seasons_dates_idx on public.official_seasons(start_date, end_date);
create table if not exists public.official_matches_editors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now()
);
alter table public.official_seasons enable row level security;
alter table public.official_matches enable row level security;
alter table public.official_matches_editors enable row level security;

create or replace function public.can_manage_official_matches()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.is_admin(), false)
      or exists (
        select 1 from public.official_matches_editors e
        where e.user_id = auth.uid()
      );
$$;
revoke all on function public.can_manage_official_matches() from public;
grant execute on function public.can_manage_official_matches() to anon, authenticated;

drop policy if exists "Official seasons are viewable by everyone" on public.official_seasons;
create policy "Official seasons are viewable by everyone" on public.official_seasons for select to anon, authenticated using (true);
drop policy if exists "Official seasons managed by page editor" on public.official_seasons;
create policy "Official seasons managed by page editor" on public.official_seasons for all to authenticated using (public.can_manage_official_matches()) with check (public.can_manage_official_matches());

drop policy if exists "Official results are viewable by everyone" on public.official_matches;
create policy "Official results are viewable by everyone" on public.official_matches for select to anon, authenticated using (true);
drop policy if exists "Official results managed by page editor" on public.official_matches;
create policy "Official results managed by page editor" on public.official_matches for all to authenticated using (public.can_manage_official_matches()) with check (public.can_manage_official_matches());

drop policy if exists "Editors can see own assignment or admins can see all" on public.official_matches_editors;
create policy "Editors can see own assignment or admins can see all" on public.official_matches_editors for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "Admins manage official editors" on public.official_matches_editors;
create policy "Admins manage official editors" on public.official_matches_editors for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select on public.official_seasons, public.official_matches to anon, authenticated;
grant insert, update, delete on public.official_seasons, public.official_matches to authenticated;
grant select, insert, update, delete on public.official_matches_editors to authenticated;

-- Public standings must include every registered player, including players with zero official matches.
create or replace view public.official_player_directory as
select id, display_name from public.players;
grant select on public.official_player_directory to anon, authenticated;

-- Initial season requested by the club. Safe to re-run.
insert into public.official_seasons(name, start_date, end_date)
select '2026 Season', date '2026-01-01', date '2026-12-31'
where not exists (
  select 1 from public.official_seasons
  where start_date = date '2026-01-01' and end_date = date '2026-12-31'
);
