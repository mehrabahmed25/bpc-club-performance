-- BPC Tournaments: additive, isolated schema.
-- Run only after reviewing the current Supabase schema and taking a backup.
-- This migration does not alter friendly-match, Official Matches, or BPC Funds objects.

create extension if not exists pgcrypto;

create table if not exists public.tournament_tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  competition_type text not null check (competition_type in ('individual','team')),
  format text not null check (format in ('round_robin','knockout','group_knockout','swiss')),
  status text not null default 'draft' check (status in ('draft','registration_open','registration_closed','in_progress','paused','completed','archived','cancelled')),
  visibility text not null default 'all_members' check (visibility in ('all_members','participants_admins','restricted')),
  registration_mode text not null default 'both' check (registration_mode in ('self','admin','both')),
  registration_requires_approval boolean not null default false,
  registration_deadline timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  participant_limit integer check (participant_limit is null or participant_limit > 0),
  score_workflow text not null default 'participant_admin' check (score_workflow in ('admin_entered','participant_admin','participant_opponent_admin')),
  rules_json jsonb not null default '{}'::jsonb,
  scoring_config_json jsonb not null default '{"win":3,"draw":1,"loss":0,"tie_breakers":["points","goal_difference","goals_for","wins"]}'::jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or ends_at >= starts_at)
);

create table if not exists public.tournament_participants (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  entrant_type text not null check (entrant_type in ('individual','team')),
  user_id uuid references auth.users(id) on delete restrict,
  cobeg_member_id uuid references public.cobeg_members(id) on delete restrict,
  external_name text,
  external_reference text,
  registration_source text not null default 'admin' check (registration_source in ('self','admin','import')),
  status text not null default 'pending' check (status in ('pending','confirmed','waitlisted','withdrawn','disqualified','rejected')),
  seed integer check (seed is null or seed > 0),
  registered_at timestamptz not null default now(),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  check (num_nonnulls(user_id,cobeg_member_id,external_name) = 1),
  check (external_name is null or length(trim(external_name)) > 0)
);

create unique index if not exists tournament_participant_user_unique
on public.tournament_participants(tournament_id,user_id) where user_id is not null and status not in ('withdrawn','rejected');
create unique index if not exists tournament_participant_cobeg_unique
on public.tournament_participants(tournament_id,cobeg_member_id) where cobeg_member_id is not null and status not in ('withdrawn','rejected');
create index if not exists tournament_participants_tournament_status_idx
on public.tournament_participants(tournament_id,status);

create table if not exists public.tournament_teams (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  participant_id uuid not null unique references public.tournament_participants(id) on delete cascade,
  team_name text not null check (length(trim(team_name)) between 2 and 100),
  team_code text,
  captain_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tournament_id,team_name)
);

create table if not exists public.tournament_team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.tournament_teams(id) on delete cascade,
  user_id uuid references auth.users(id) on delete restrict,
  cobeg_member_id uuid references public.cobeg_members(id) on delete restrict,
  external_name text,
  role text not null default 'member' check (role in ('member','captain')),
  status text not null default 'active' check (status in ('active','removed')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  check (num_nonnulls(user_id,cobeg_member_id,external_name) = 1)
);
create unique index if not exists tournament_team_member_account_unique
on public.tournament_team_members(team_id,user_id) where user_id is not null and status='active';
create unique index if not exists tournament_team_member_cobeg_unique
on public.tournament_team_members(team_id,cobeg_member_id) where cobeg_member_id is not null and status='active';

create table if not exists public.tournament_stages (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  name text not null,
  stage_type text not null check (stage_type in ('round_robin','knockout','group','swiss')),
  sequence_number integer not null check (sequence_number > 0),
  status text not null default 'pending' check (status in ('pending','active','completed','cancelled')),
  settings_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(tournament_id,sequence_number)
);

create table if not exists public.tournament_groups (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.tournament_stages(id) on delete cascade,
  name text not null,
  sequence_number integer not null default 1 check (sequence_number > 0),
  unique(stage_id,name),
  unique(stage_id,sequence_number)
);

create table if not exists public.tournament_stage_entries (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.tournament_stages(id) on delete cascade,
  participant_id uuid not null references public.tournament_participants(id) on delete cascade,
  group_id uuid references public.tournament_groups(id) on delete set null,
  seed integer check (seed is null or seed > 0),
  entry_status text not null default 'active' check (entry_status in ('active','qualified','eliminated','withdrawn','disqualified')),
  created_at timestamptz not null default now(),
  unique(stage_id,participant_id)
);

create table if not exists public.tournament_pairing_runs (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  stage_id uuid not null references public.tournament_stages(id) on delete cascade,
  round_number integer not null check (round_number > 0),
  run_number integer not null default 1 check (run_number > 0),
  status text not null default 'preview' check (status in ('preview','published','superseded','failed')),
  config_json jsonb not null default '{}'::jsonb,
  diagnostics_json jsonb not null default '[]'::jsonb,
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),
  published_at timestamptz,
  reason text,
  unique(stage_id,round_number,run_number)
);

create table if not exists public.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  stage_id uuid not null references public.tournament_stages(id) on delete cascade,
  group_id uuid references public.tournament_groups(id) on delete set null,
  pairing_run_id uuid references public.tournament_pairing_runs(id) on delete set null,
  round_number integer not null check (round_number > 0),
  match_number integer not null check (match_number > 0),
  participant_a_id uuid references public.tournament_participants(id) on delete restrict,
  participant_b_id uuid references public.tournament_participants(id) on delete restrict,
  scheduled_at timestamptz,
  venue_or_note text,
  status text not null default 'scheduled' check (status in ('scheduled','pending_result','pending_confirmation','disputed','approved','rejected','postponed','cancelled','bye','completed')),
  score_a integer check (score_a is null or score_a >= 0),
  score_b integer check (score_b is null or score_b >= 0),
  winner_participant_id uuid references public.tournament_participants(id) on delete restrict,
  submitted_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_at timestamptz,
  result_version integer not null default 0 check (result_version >= 0),
  supersedes_match_id uuid references public.tournament_matches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(stage_id,round_number,match_number),
  check (participant_a_id is null or participant_b_id is null or participant_a_id <> participant_b_id)
);
create index if not exists tournament_matches_tournament_round_idx
on public.tournament_matches(tournament_id,stage_id,round_number,match_number);
create index if not exists tournament_matches_status_idx
on public.tournament_matches(tournament_id,status);

create table if not exists public.tournament_result_submissions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.tournament_matches(id) on delete cascade,
  submitted_by uuid references auth.users(id) on delete set null,
  score_a integer not null check (score_a >= 0),
  score_b integer not null check (score_b >= 0),
  note text,
  status text not null default 'pending' check (status in ('pending','awaiting_opponent','approved','rejected','disputed','superseded')),
  opponent_confirmed_by uuid references auth.users(id) on delete set null,
  opponent_confirmed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now()
);
create index if not exists tournament_result_submissions_match_idx
on public.tournament_result_submissions(match_id,created_at desc);

create table if not exists public.tournament_result_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.tournament_result_submissions(id) on delete cascade,
  action text not null check (action in ('confirmed','approved','rejected','disputed','resolved','corrected')),
  actor_user_id uuid references auth.users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.tournament_standings_snapshots (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  stage_id uuid references public.tournament_stages(id) on delete cascade,
  snapshot_version integer not null,
  standings_json jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique(tournament_id,stage_id,snapshot_version)
);

create table if not exists public.tournament_audit_logs (
  id bigint generated always as identity primary key,
  tournament_id uuid references public.tournament_tournaments(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  reason text,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists tournament_audit_logs_tournament_time_idx
on public.tournament_audit_logs(tournament_id,created_at desc);

create table if not exists public.tournament_announcements (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 140),
  body text not null check (length(trim(body)) > 0),
  status text not null default 'draft' check (status in ('draft','published','archived')),
  published_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tournament_awards (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  participant_id uuid references public.tournament_participants(id) on delete set null,
  title text not null,
  description text,
  awarded_by uuid references auth.users(id) on delete set null,
  awarded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Admin predicate matches the existing BPC profiles.role convention.
create or replace function public.tournament_is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'); $$;

create or replace function public.tournament_is_participant(p_tournament_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
 select exists (
   select 1 from public.tournament_participants tp
   where tp.tournament_id = p_tournament_id and tp.status in ('pending','confirmed','waitlisted')
   and (tp.user_id = auth.uid() or exists (
     select 1 from public.tournament_team_members tm
     join public.tournament_teams tt on tt.id = tm.team_id
     where tt.participant_id = tp.id and tm.user_id = auth.uid() and tm.status = 'active'
   ))
 );
$$;

create or replace function public.tournament_can_view(p_tournament_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
 select public.tournament_is_admin() or exists (
   select 1 from public.tournament_tournaments t
   where t.id = p_tournament_id and t.status <> 'draft' and (
     t.visibility = 'all_members'
     or (t.visibility = 'participants_admins' and public.tournament_is_participant(t.id))
     or (t.visibility = 'restricted' and public.tournament_is_participant(t.id))
   )
 );
$$;

alter table public.tournament_tournaments enable row level security;
alter table public.tournament_participants enable row level security;
alter table public.tournament_teams enable row level security;
alter table public.tournament_team_members enable row level security;
alter table public.tournament_stages enable row level security;
alter table public.tournament_groups enable row level security;
alter table public.tournament_stage_entries enable row level security;
alter table public.tournament_pairing_runs enable row level security;
alter table public.tournament_matches enable row level security;
alter table public.tournament_result_submissions enable row level security;
alter table public.tournament_result_reviews enable row level security;
alter table public.tournament_standings_snapshots enable row level security;
alter table public.tournament_audit_logs enable row level security;
alter table public.tournament_announcements enable row level security;
alter table public.tournament_awards enable row level security;

-- All table policies are explicitly tournament-scoped; no existing policies are touched.
drop policy if exists tournament_tournaments_view on public.tournament_tournaments;
create policy tournament_tournaments_view on public.tournament_tournaments for select to authenticated
using (public.tournament_is_admin() or (status <> 'draft' and (visibility = 'all_members' or (visibility in ('participants_admins','restricted') and public.tournament_is_participant(id)))));
drop policy if exists tournament_tournaments_admin on public.tournament_tournaments;
create policy tournament_tournaments_admin on public.tournament_tournaments for all to authenticated
using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_participants_view on public.tournament_participants;
create policy tournament_participants_view on public.tournament_participants for select to authenticated
using (public.tournament_is_admin() or user_id = auth.uid() or public.tournament_can_view(tournament_id) or exists (
 select 1 from public.tournament_teams tt join public.tournament_team_members tm on tm.team_id=tt.id
 where tt.participant_id=tournament_participants.id and tm.user_id=auth.uid() and tm.status='active'
));
drop policy if exists tournament_participants_admin on public.tournament_participants;
create policy tournament_participants_admin on public.tournament_participants for all to authenticated
using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_teams_view on public.tournament_teams;
create policy tournament_teams_view on public.tournament_teams for select to authenticated
using (public.tournament_is_admin() or public.tournament_can_view(tournament_id) or captain_user_id=auth.uid());
drop policy if exists tournament_teams_admin on public.tournament_teams;
create policy tournament_teams_admin on public.tournament_teams for all to authenticated
using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_team_members_view on public.tournament_team_members;
create policy tournament_team_members_view on public.tournament_team_members for select to authenticated
using (public.tournament_is_admin() or user_id=auth.uid() or exists(select 1 from public.tournament_teams tt where tt.id=team_id and (tt.captain_user_id=auth.uid() or public.tournament_can_view(tt.tournament_id))));
drop policy if exists tournament_team_members_admin on public.tournament_team_members;
create policy tournament_team_members_admin on public.tournament_team_members for all to authenticated
using (public.tournament_is_admin()) with check (public.tournament_is_admin());

-- Read access for stages, groups, entries and matches follows tournament visibility.
drop policy if exists tournament_stages_view on public.tournament_stages;
create policy tournament_stages_view on public.tournament_stages for select to authenticated using (public.tournament_can_view(tournament_id));
drop policy if exists tournament_stages_admin on public.tournament_stages;
create policy tournament_stages_admin on public.tournament_stages for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_groups_view on public.tournament_groups;
create policy tournament_groups_view on public.tournament_groups for select to authenticated using (exists(select 1 from public.tournament_stages s where s.id=stage_id and public.tournament_can_view(s.tournament_id)));
drop policy if exists tournament_groups_admin on public.tournament_groups;
create policy tournament_groups_admin on public.tournament_groups for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_stage_entries_view on public.tournament_stage_entries;
create policy tournament_stage_entries_view on public.tournament_stage_entries for select to authenticated using (exists(select 1 from public.tournament_stages s where s.id=stage_id and public.tournament_can_view(s.tournament_id)));
drop policy if exists tournament_stage_entries_admin on public.tournament_stage_entries;
create policy tournament_stage_entries_admin on public.tournament_stage_entries for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_pairing_runs_view on public.tournament_pairing_runs;
create policy tournament_pairing_runs_view on public.tournament_pairing_runs for select to authenticated using (public.tournament_is_admin() or public.tournament_can_view(tournament_id));
drop policy if exists tournament_pairing_runs_admin on public.tournament_pairing_runs;
create policy tournament_pairing_runs_admin on public.tournament_pairing_runs for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_matches_view on public.tournament_matches;
create policy tournament_matches_view on public.tournament_matches for select to authenticated using (public.tournament_can_view(tournament_id));
drop policy if exists tournament_matches_admin on public.tournament_matches;
create policy tournament_matches_admin on public.tournament_matches for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

-- Participants may create their own score proposals. Only admins may review or change submissions.
drop policy if exists tournament_submissions_view on public.tournament_result_submissions;
create policy tournament_submissions_view on public.tournament_result_submissions for select to authenticated
using (public.tournament_is_admin() or submitted_by=auth.uid() or exists(
 select 1 from public.tournament_matches m where m.id=match_id and
 (public.tournament_is_participant(m.tournament_id))
));
drop policy if exists tournament_submissions_insert on public.tournament_result_submissions;
create policy tournament_submissions_insert on public.tournament_result_submissions for insert to authenticated
with check (submitted_by=auth.uid() and exists(
 select 1 from public.tournament_matches m
 join public.tournament_tournaments t on t.id=m.tournament_id
 where m.id=match_id and t.score_workflow in ('participant_admin','participant_opponent_admin')
 and m.status in ('scheduled','rejected') and public.tournament_is_participant(m.tournament_id)
 and (auth.uid() in (select tp.user_id from public.tournament_participants tp where tp.id in (m.participant_a_id,m.participant_b_id))
   or exists(select 1 from public.tournament_teams tt join public.tournament_team_members tm on tm.team_id=tt.id where tt.participant_id in (m.participant_a_id,m.participant_b_id) and tm.user_id=auth.uid() and tm.status='active'))
));
drop policy if exists tournament_submissions_admin on public.tournament_result_submissions;
create policy tournament_submissions_admin on public.tournament_result_submissions for update to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_reviews_view on public.tournament_result_reviews;
create policy tournament_reviews_view on public.tournament_result_reviews for select to authenticated using (public.tournament_is_admin());
drop policy if exists tournament_reviews_admin on public.tournament_result_reviews;
create policy tournament_reviews_admin on public.tournament_result_reviews for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_standings_view on public.tournament_standings_snapshots;
create policy tournament_standings_view on public.tournament_standings_snapshots for select to authenticated using (public.tournament_can_view(tournament_id));
drop policy if exists tournament_standings_admin on public.tournament_standings_snapshots;
create policy tournament_standings_admin on public.tournament_standings_snapshots for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_audit_admin on public.tournament_audit_logs;
create policy tournament_audit_admin on public.tournament_audit_logs for select to authenticated using (public.tournament_is_admin());
drop policy if exists tournament_audit_insert on public.tournament_audit_logs;
create policy tournament_audit_insert on public.tournament_audit_logs for insert to authenticated with check (actor_user_id=auth.uid() and public.tournament_is_admin());

drop policy if exists tournament_announcements_view on public.tournament_announcements;
create policy tournament_announcements_view on public.tournament_announcements for select to authenticated
using (public.tournament_is_admin() or (status='published' and public.tournament_can_view(tournament_id)));
drop policy if exists tournament_announcements_admin on public.tournament_announcements;
create policy tournament_announcements_admin on public.tournament_announcements for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

drop policy if exists tournament_awards_view on public.tournament_awards;
create policy tournament_awards_view on public.tournament_awards for select to authenticated using (public.tournament_can_view(tournament_id));
drop policy if exists tournament_awards_admin on public.tournament_awards;
create policy tournament_awards_admin on public.tournament_awards for all to authenticated using (public.tournament_is_admin()) with check (public.tournament_is_admin());

grant select, insert, update, delete on public.tournament_tournaments to authenticated;
grant select, insert, update, delete on public.tournament_participants to authenticated;
grant select, insert, update, delete on public.tournament_teams to authenticated;
grant select, insert, update, delete on public.tournament_team_members to authenticated;
grant select, insert, update, delete on public.tournament_stages to authenticated;
grant select, insert, update, delete on public.tournament_groups to authenticated;
grant select, insert, update, delete on public.tournament_stage_entries to authenticated;
grant select, insert, update, delete on public.tournament_pairing_runs to authenticated;
grant select, insert, update, delete on public.tournament_matches to authenticated;
grant select, insert, update, delete on public.tournament_result_submissions to authenticated;
grant select, insert, update, delete on public.tournament_result_reviews to authenticated;
grant select, insert, update, delete on public.tournament_standings_snapshots to authenticated;
grant select, insert, update, delete on public.tournament_audit_logs to authenticated;
grant select, insert, update, delete on public.tournament_announcements to authenticated;
grant select, insert, update, delete on public.tournament_awards to authenticated;
grant execute on function public.tournament_is_admin() to authenticated;
grant execute on function public.tournament_is_participant(uuid) to authenticated;
grant execute on function public.tournament_can_view(uuid) to authenticated;

-- Force audit records to be append-only through the API.
drop policy if exists tournament_audit_no_update on public.tournament_audit_logs;
create policy tournament_audit_no_update on public.tournament_audit_logs for update to authenticated using (false);
drop policy if exists tournament_audit_no_delete on public.tournament_audit_logs;
create policy tournament_audit_no_delete on public.tournament_audit_logs for delete to authenticated using (false);
