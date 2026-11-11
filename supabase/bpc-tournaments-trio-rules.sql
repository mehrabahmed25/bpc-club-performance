-- BPC Trio rules (Nov 2026)
-- 1. Original lineup: each team has a fixed order (1st, 2nd, 3rd pick). Board k = home pick k v away pick k.
--    Captains can reorder until fixtures exist; admins can always reorder.
-- 2. Home team = participant_a. Round-robin home games are balanced (equal, or one apart).
-- 3. Home swap: the home captain may swap their 1st and 2nd pick once per fixture, before the deadline,
--    and only while boards 1 and 2 are unplayed. The 3rd pick never moves. No counter-swap.
-- 4. Walkover by board: a captain reports a player unavailable, an admin confirms. Forfeited board = 3-0.
--    Both sides unavailable = 0-0 double walkover. Walkover boards are left out of player stats.
-- 5. Replacement: admin replaces a player in the same slot, at most 2 per team. Unplayed boards update.

alter table public.tournament_team_members
  add column if not exists slot int,
  add column if not exists replaced_by uuid references public.tournament_team_members(id);
alter table public.tournament_boards add column if not exists wo_side text check (wo_side in ('a','b','both'));

create table if not exists public.tournament_trio_swaps(
  match_id uuid primary key references public.tournament_matches(id) on delete cascade,
  participant_id uuid not null references public.tournament_participants(id) on delete cascade,
  swapped_by uuid, swapped_at timestamptz not null default now());
create table if not exists public.tournament_trio_wo_reports(
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.tournament_boards(id) on delete cascade,
  side text not null check (side in ('a','b')),
  reason text, reported_by uuid, created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid, decided_at timestamptz);
create unique index if not exists tournament_trio_wo_reports_one_pending on public.tournament_trio_wo_reports(board_id, side) where status = 'pending';
alter table public.tournament_trio_swaps enable row level security;
alter table public.tournament_trio_wo_reports enable row level security;
revoke all on public.tournament_trio_swaps, public.tournament_trio_wo_reports from anon, authenticated;

-- old per-fixture hidden lineups are replaced by the original lineup
drop function if exists public.tournament_trio_set_lineup(uuid, uuid, uuid[]);
drop function if exists public.tournament_trio_admin_reset_lineup(uuid, text);
drop function if exists public.tournament_trio_swap(uuid, uuid, int, int);

-- team order (internal) ---------------------------------------------------------
create or replace function public.tournament_trio_order(p_participant uuid) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select array_agg(tm.id order by tm.slot nulls last, (tm.role = 'captain') desc, tm.joined_at, tm.id)
  from tournament_team_members tm join tournament_teams tt on tt.id = tm.team_id
  where tt.participant_id = p_participant and tm.status = 'active'
$$;
create or replace function public.tournament_trio_fix_slots(p_team uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update tournament_team_members tm set slot = o.rn
  from (select id, row_number() over (order by slot nulls last, (role = 'captain') desc, joined_at, id) rn
        from tournament_team_members where team_id = p_team and status = 'active') o
  where tm.id = o.id and tm.slot is distinct from o.rn
$$;

-- (re)build the unplayed boards of an open fixture from both team orders and the home swap (internal)
create or replace function public.tournament_trio_sync_boards(p_match uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m tournament_matches; games int; oa uuid[]; ob uuid[]; tmp uuid; i int;
begin
  select * into m from tournament_matches where id = p_match;
  if not found or m.participant_b_id is null or m.status not in ('scheduled','rejected') then return; end if;
  games := public.tournament_trio_games(m.tournament_id);
  if games < 2 then return; end if;
  oa := public.tournament_trio_order(m.participant_a_id); ob := public.tournament_trio_order(m.participant_b_id);
  if coalesce(cardinality(oa), 0) < games or coalesce(cardinality(ob), 0) < games then return; end if;
  if exists(select 1 from tournament_trio_swaps where match_id = m.id) then tmp := oa[1]; oa[1] := oa[2]; oa[2] := tmp; end if;
  for i in 1..games loop
    insert into tournament_boards(match_id, board_no, a_member_id, b_member_id) values (m.id, i, oa[i], ob[i])
    on conflict (match_id, board_no) do update set a_member_id = excluded.a_member_id, b_member_id = excluded.b_member_id
      where tournament_boards.status = 'scheduled' and tournament_boards.wo_side is null;
  end loop;
end $$;

-- balanced home games: participant_a is the home team ------------------------------
create or replace function public.tournament_trio_home_balance() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids uuid[]; n int; k int; ia int; ib int; d int; a_home boolean; st text; tmp uuid;
begin
  if new.participant_a_id is null or new.participant_b_id is null then return new; end if;
  if public.tournament_trio_games(new.tournament_id) < 2 then return new; end if;
  select stage_type into st from tournament_stages where id = new.stage_id;
  if st is null or st not in ('round_robin','group') then return new; end if;
  select array_agg(se.participant_id order by coalesce(se.seed, 2147483647), se.participant_id) into ids
  from tournament_stage_entries se join tournament_participants p on p.id = se.participant_id
  where se.stage_id = new.stage_id and se.entry_status in ('active','qualified') and p.status = 'confirmed'
    and (new.group_id is null or se.group_id = new.group_id);
  n := coalesce(cardinality(ids), 0);
  ia := array_position(ids, new.participant_a_id) - 1; ib := array_position(ids, new.participant_b_id) - 1;
  if ia is null or ib is null then return new; end if;
  -- odd field: cyclic orientation gives everyone the same number of home games.
  -- even field: the last team sits outside the cycle and is at home against every other team in the cycle.
  k := case when n % 2 = 1 then n else n - 1 end;
  if ia < k and ib < k then
    d := ((ib - ia) % k + k) % k;
    a_home := d between 1 and (k - 1) / 2;
  elsif ia = k then a_home := ib % 2 = 0;
  else a_home := not (ia % 2 = 0);
  end if;
  if not a_home then tmp := new.participant_a_id; new.participant_a_id := new.participant_b_id; new.participant_b_id := tmp; end if;
  return new;
end $$;
drop trigger if exists tournament_trio_home_balance on public.tournament_matches;
create trigger tournament_trio_home_balance before insert on public.tournament_matches for each row execute function public.tournament_trio_home_balance();

create or replace function public.tournament_trio_make_boards() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.participant_b_id is not null and public.tournament_trio_games(new.tournament_id) > 1 then perform public.tournament_trio_sync_boards(new.id); end if;
  return new;
end $$;
drop trigger if exists tournament_trio_make_boards on public.tournament_matches;
create trigger tournament_trio_make_boards after insert on public.tournament_matches for each row execute function public.tournament_trio_make_boards();

-- size check before fixtures also fixes every team's order (1, 2, 3)
create or replace function public.tournament_check_team_sizes() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare sz int; bad text; r record;
begin
  sz := public.tournament_team_size(new.tournament_id);
  if sz is null then return new; end if;
  select string_agg(tt.team_name || ' (' || n || '/' || sz || ')', ', ') into bad from (
    select tt.id, tt.team_name, (select count(*) from tournament_team_members tm where tm.team_id = tt.id and tm.status = 'active') n
    from tournament_teams tt join tournament_participants p on p.id = tt.participant_id
    where tt.tournament_id = new.tournament_id and p.status = 'confirmed') tt where n <> sz;
  if bad is not null then raise exception 'Every team needs exactly % players before fixtures can be made. Check: %', sz, bad; end if;
  for r in select tt.id from tournament_teams tt join tournament_participants p on p.id = tt.participant_id
           where tt.tournament_id = new.tournament_id and p.status = 'confirmed' loop
    perform public.tournament_trio_fix_slots(r.id);
  end loop;
  return new;
end $$;

-- original lineup ----------------------------------------------------------------
create or replace function public.tournament_trio_set_order(p_team_id uuid, p_members uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare tt tournament_teams; t tournament_tournaments; adm boolean := coalesce(public.tournament_is_admin(), false); act uuid[]; i int; r record;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into tt from tournament_teams where id = p_team_id for update;
  if not found then raise exception 'Team not found'; end if;
  select * into t from tournament_tournaments where id = tt.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if not adm then
    if tt.captain_user_id is distinct from auth.uid() then raise exception 'Only the captain or an administrator can set the lineup'; end if;
    if exists(select 1 from tournament_matches where tournament_id = t.id) then raise exception 'The lineup is locked because fixtures have been made. Please contact an administrator.'; end if;
  end if;
  select array_agg(id order by id) into act from tournament_team_members where team_id = tt.id and status = 'active';
  if p_members is null or cardinality(p_members) <> coalesce(cardinality(act), 0)
     or (select array_agg(x order by x) from unnest(p_members) x) is distinct from act then
    raise exception 'The lineup must list every player on the team exactly once'; end if;
  for i in 1..cardinality(p_members) loop
    update tournament_team_members set slot = i where id = p_members[i];
  end loop;
  for r in select id from tournament_matches where status in ('scheduled','rejected') and (participant_a_id = tt.participant_id or participant_b_id = tt.participant_id) loop
    perform public.tournament_trio_sync_boards(r.id);
  end loop;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (t.id, auth.uid(), 'trio_lineup_order', 'team', tt.id::text);
end $$;

-- home swap ------------------------------------------------------------------------
create or replace function public.tournament_trio_home_swap(p_match_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m tournament_matches; t tournament_tournaments; cap uuid; adm boolean := coalesce(public.tournament_is_admin(), false); n int;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into m from tournament_matches where id = p_match_id for update;
  if not found or m.participant_b_id is null then raise exception 'Match not found'; end if;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if m.status not in ('scheduled','rejected') then raise exception 'This fixture is no longer open'; end if;
  select captain_user_id into cap from tournament_teams where participant_id = m.participant_a_id;
  if not adm then
    if cap is distinct from auth.uid() then raise exception 'Only the home team captain can swap'; end if;
    if m.deadline_at is not null and now() > m.deadline_at then raise exception 'The swap deadline has passed'; end if;
  end if;
  if exists(select 1 from tournament_trio_swaps where match_id = m.id) then raise exception 'The home team has already used its swap for this fixture'; end if;
  select count(*) into n from tournament_boards where match_id = m.id and board_no in (1, 2) and status = 'scheduled' and wo_side is null;
  if n < 2 then raise exception 'The swap closed once a game on board 1 or 2 was played'; end if;
  insert into tournament_trio_swaps(match_id, participant_id, swapped_by) values (m.id, m.participant_a_id, auth.uid());
  perform public.tournament_trio_sync_boards(m.id);
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (m.tournament_id, auth.uid(), 'trio_home_swap', 'match', m.id::text);
end $$;

-- walkovers ------------------------------------------------------------------------
-- p_side is the side that forfeits: 'a', 'b' or 'both' (internal)
create or replace function public.tournament_trio_apply_wo(p_board uuid, p_side text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; s text;
begin
  select * into b from tournament_boards where id = p_board for update;
  s := case when b.wo_side is not null and b.wo_side <> p_side then 'both' else p_side end;
  update tournament_boards set wo_side = s,
    score_a = case s when 'a' then 0 when 'b' then 3 else 0 end,
    score_b = case s when 'a' then 3 when 'b' then 0 else 0 end,
    status = 'approved', approved_by = auth.uid(), approved_at = now(), review_reason = coalesce(p_reason, 'Walkover'),
    submitted_by = null, submitted_at = null, confirmed_by = null, confirmed_at = null
  where id = b.id;
  perform public.tournament_trio_finalize(b.match_id);
end $$;

create or replace function public.tournament_trio_report_unavailable(p_board_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; m tournament_matches; t tournament_tournaments; s text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into b from tournament_boards where id = p_board_id;
  if not found then raise exception 'Game not found'; end if;
  select * into m from tournament_matches where id = b.match_id;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if b.status <> 'scheduled' or b.wo_side is not null then raise exception 'This game has already been played or decided'; end if;
  s := case when auth.uid() = (select captain_user_id from tournament_teams where participant_id = m.participant_a_id) then 'a'
            when auth.uid() = (select captain_user_id from tournament_teams where participant_id = m.participant_b_id) then 'b' end;
  if s is null then raise exception 'Only a captain in this fixture can report an unavailable player'; end if;
  if exists(select 1 from tournament_trio_wo_reports where board_id = b.id and side = s and status = 'pending') then raise exception 'You have already reported this game'; end if;
  insert into tournament_trio_wo_reports(board_id, side, reason, reported_by) values (b.id, s, nullif(trim(p_reason), ''), auth.uid());
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id, reason) values (m.tournament_id, auth.uid(), 'trio_unavailable_reported', 'board', b.id::text, p_reason);
end $$;

create or replace function public.tournament_trio_decide_unavailable(p_report_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r tournament_trio_wo_reports; b tournament_boards; m tournament_matches;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into r from tournament_trio_wo_reports where id = p_report_id for update;
  if not found or r.status <> 'pending' then raise exception 'This report has already been handled'; end if;
  select * into b from tournament_boards where id = r.board_id;
  select * into m from tournament_matches where id = b.match_id;
  update tournament_trio_wo_reports set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now() where id = r.id;
  if p_approve then
    if b.status not in ('scheduled') and b.wo_side is null then raise exception 'This game already has a score. Clear it first.'; end if;
    perform public.tournament_trio_apply_wo(b.id, r.side, 'Walkover: player unavailable');
  end if;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (m.tournament_id, auth.uid(), case when p_approve then 'trio_walkover_confirmed' else 'trio_walkover_rejected' end, 'board', b.id::text);
end $$;

-- admin: set a walkover directly ('a', 'b', 'both' forfeit) or clear one ('clear')
create or replace function public.tournament_trio_admin_walkover(p_board_id uuid, p_side text, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; m tournament_matches; t tournament_tournaments;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if p_side not in ('a','b','both','clear') then raise exception 'Choose which side forfeits'; end if;
  select * into b from tournament_boards where id = p_board_id for update;
  if not found then raise exception 'Game not found'; end if;
  select * into m from tournament_matches where id = b.match_id;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if p_side = 'clear' then
    update tournament_boards set wo_side = null, score_a = null, score_b = null, status = 'scheduled', approved_by = null, approved_at = null, review_reason = p_reason where id = b.id;
    perform public.tournament_trio_finalize(b.match_id);
    perform public.tournament_trio_sync_boards(b.match_id);
  else
    update tournament_boards set wo_side = null where id = b.id;
    perform public.tournament_trio_apply_wo(b.id, p_side, coalesce(p_reason, 'Walkover'));
  end if;
  update tournament_trio_wo_reports set status = 'approved', decided_by = auth.uid(), decided_at = now()
    where board_id = b.id and status = 'pending' and p_side <> 'clear' and (side = p_side or p_side = 'both');
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id, reason) values (m.tournament_id, auth.uid(), 'trio_walkover_'||p_side, 'board', b.id::text, p_reason);
end $$;

-- admin score entry clears any walkover
create or replace function public.tournament_trio_admin_set_game(p_board_id uuid, p_score_a int, p_score_b int, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; m tournament_matches; t tournament_tournaments;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if p_score_a is null or p_score_b is null or p_score_a < 0 or p_score_b < 0 or p_score_a > 99 or p_score_b > 99 then raise exception 'Enter a whole-number score from 0 to 99 for both players'; end if;
  select * into b from tournament_boards where id = p_board_id for update;
  if not found then raise exception 'Game not found'; end if;
  select * into m from tournament_matches where id = b.match_id;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  update tournament_boards set score_a = p_score_a, score_b = p_score_b, status = 'approved', wo_side = null, submitted_by = coalesce(submitted_by, auth.uid()),
    submitted_at = coalesce(submitted_at, now()), approved_by = auth.uid(), approved_at = now(), review_reason = p_reason where id = b.id;
  perform public.tournament_trio_finalize(b.match_id);
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id, reason) values (m.tournament_id, auth.uid(), 'trio_game_admin_set', 'board', b.id::text, p_reason);
end $$;

-- replacement ------------------------------------------------------------------------
create or replace function public.tournament_trio_replace_player(p_member_id uuid, p_user_id uuid default null, p_name text default null, p_reason text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare tm tournament_team_members; tt tournament_teams; t tournament_tournaments; used int; new_id uuid;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if num_nonnulls(p_user_id, nullif(trim(p_name), '')) <> 1 then raise exception 'Choose a registered player or type a name, not both'; end if;
  select * into tm from tournament_team_members where id = p_member_id for update;
  if not found or tm.status <> 'active' then raise exception 'Player not found on a team'; end if;
  select * into tt from tournament_teams where id = tm.team_id for update;
  select * into t from tournament_tournaments where id = tt.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  select count(*) into used from tournament_team_members where team_id = tt.id and replaced_by is not null;
  if used >= 2 then raise exception '% has already used both replacements', tt.team_name; end if;
  if tm.role = 'captain' and p_user_id is null then raise exception 'A replacement captain must be a registered player'; end if;
  if public.tournament_player_on_live_team(t.id, p_user_id, null, p_name) then raise exception 'That player is already in a team in this tournament'; end if;
  update tournament_team_members set status = 'removed', left_at = now() where id = tm.id;
  insert into tournament_team_members(team_id, user_id, external_name, role, slot)
    values (tt.id, p_user_id, case when p_user_id is null then trim(p_name) end, tm.role, tm.slot) returning id into new_id;
  update tournament_team_members set replaced_by = new_id where id = tm.id;
  if tm.role = 'captain' then
    update tournament_teams set captain_user_id = p_user_id where id = tt.id;
    update tournament_participants set user_id = p_user_id where id = tt.participant_id;
  end if;
  update tournament_boards set a_member_id = new_id where a_member_id = tm.id and status = 'scheduled' and wo_side is null;
  update tournament_boards set b_member_id = new_id where b_member_id = tm.id and status = 'scheduled' and wo_side is null;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id, reason)
    values (t.id, auth.uid(), 'trio_player_replaced', 'team_member', tm.id::text, p_reason);
  return new_id;
end $$;

-- a player who is already in fixtures is replaced, not removed
create or replace function public.tournament_team_remove_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare tm tournament_team_members%rowtype; v_team tournament_teams%rowtype; v_t tournament_tournaments%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into tm from tournament_team_members where id = p_member_id for update;
  if not found or tm.status <> 'active' then raise exception 'Player not found on a team'; end if;
  select * into v_team from tournament_teams where id = tm.team_id;
  select * into v_t from tournament_tournaments where id = v_team.tournament_id;
  if not public.tournament_is_admin() then
    if v_team.captain_user_id <> auth.uid() then raise exception 'Only the captain or an administrator may manage this roster'; end if;
    if tm.role = 'captain' then raise exception 'The captain cannot be removed'; end if;
    if v_t.status <> 'registration_open' or (v_t.registration_deadline is not null and v_t.registration_deadline < now()) then raise exception 'Rosters are locked because registration has closed'; end if;
  end if;
  if exists(select 1 from tournament_boards b where b.a_member_id = p_member_id or b.b_member_id = p_member_id) then
    raise exception 'That player is already in fixtures. Use Replace player instead.'; end if;
  update tournament_team_members set status = 'removed', left_at = now(), slot = null where id = p_member_id;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (v_team.tournament_id, auth.uid(), 'team_member_removed', 'team_member', p_member_id::text);
end $$;

-- reads ---------------------------------------------------------------------------------
create or replace function public.tournament_rosters(p_tournament_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); adm boolean := coalesce(public.tournament_is_admin(), false); t tournament_tournaments; sz int; open_reg boolean; has_fx boolean; ended boolean; res jsonb;
begin
  select * into t from tournament_tournaments where id = p_tournament_id;
  if not found or not public.tournament_can_view(p_tournament_id) then raise exception 'Not allowed'; end if;
  sz := public.tournament_team_size(p_tournament_id);
  open_reg := t.status = 'registration_open' and (t.registration_deadline is null or t.registration_deadline >= now());
  has_fx := exists(select 1 from tournament_matches where tournament_id = t.id);
  ended := t.status in ('completed','archived','cancelled');
  select coalesce(jsonb_agg(jsonb_build_object(
      'team_id', tt.id, 'participant_id', tt.participant_id, 'team_name', tt.team_name, 'status', p.status,
      'is_captain', uid is not null and tt.captain_user_id = uid,
      'can_manage', not ended and (adm or (uid is not null and tt.captain_user_id = uid and open_reg and not has_fx)),
      'can_order', not ended and (adm or (uid is not null and tt.captain_user_id = uid and not has_fx)),
      'can_replace', not ended and adm and has_fx,
      'size', sz,
      'home_games', (select count(*) from tournament_matches m where m.participant_a_id = tt.participant_id and m.participant_b_id is not null),
      'away_games', (select count(*) from tournament_matches m where m.participant_b_id = tt.participant_id),
      'replacements', (select count(*) from tournament_team_members r where r.team_id = tt.id and r.replaced_by is not null),
      'members', (select coalesce(jsonb_agg(jsonb_build_object('id', tm.id, 'name', public.tournament_member_name(tm.id), 'captain', tm.role = 'captain', 'user_id', tm.user_id, 'slot', tm.slot)
                    order by tm.slot nulls last, (tm.role = 'captain') desc, tm.joined_at, tm.id), '[]')
                  from tournament_team_members tm where tm.team_id = tt.id and tm.status = 'active')
    ) order by tt.team_name), '[]') into res
  from tournament_teams tt join tournament_participants p on p.id = tt.participant_id
  where tt.tournament_id = p_tournament_id and p.status not in ('withdrawn','rejected','disqualified')
    and (adm or p.status = 'confirmed' or tt.captain_user_id = uid);
  return res;
end $$;

create or replace function public.tournament_trio_fixture(p_match_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m tournament_matches; t tournament_tournaments; uid uuid := auth.uid();
  adm boolean := coalesce(public.tournament_is_admin(), false); games int; ended boolean; dl boolean;
  capa uuid; capb uuid; sw tournament_trio_swaps; open12 int; mine text; bj jsonb; sm jsonb; isopen boolean;
begin
  select * into m from tournament_matches where id = p_match_id;
  if not found then raise exception 'Match not found'; end if;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if not public.tournament_can_view(t.id) then raise exception 'Not allowed'; end if;
  games := public.tournament_trio_games(t.id);
  if games < 2 or m.participant_b_id is null then return jsonb_build_object('trio', false); end if;
  ended := t.status in ('completed','archived','cancelled');
  dl := m.deadline_at is not null and now() > m.deadline_at;
  isopen := not ended and m.status in ('scheduled','rejected');
  select captain_user_id into capa from tournament_teams where participant_id = m.participant_a_id;
  select captain_user_id into capb from tournament_teams where participant_id = m.participant_b_id;
  mine := case when uid is null then null when uid = capa then 'a' when uid = capb then 'b' end;
  select * into sw from tournament_trio_swaps where match_id = m.id;
  select count(*) into open12 from tournament_boards where match_id = m.id and board_no in (1, 2) and status = 'scheduled' and wo_side is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'board_no', b.board_no, 'status', b.status, 'score_a', b.score_a, 'score_b', b.score_b, 'wo_side', b.wo_side,
      'a', jsonb_build_object('id', b.a_member_id, 'name', public.tournament_member_name(b.a_member_id)),
      'b', jsonb_build_object('id', b.b_member_id, 'name', public.tournament_member_name(b.b_member_id)),
      'can_submit', isopen and b.status = 'scheduled' and b.wo_side is null and t.score_workflow <> 'admin_entered' and not dl
                    and public.tournament_trio_side(b.id, uid) is not null,
      'can_confirm', not ended and b.status = 'awaiting_opponent' and t.score_workflow = 'participant_opponent_admin'
                    and public.tournament_trio_side(b.id, uid) is not null and b.submitted_by is distinct from uid
                    and public.tournament_trio_side(b.id, uid) is distinct from public.tournament_trio_side(b.id, b.submitted_by),
      'can_report', isopen and mine is not null and b.status = 'scheduled' and b.wo_side is null
                    and not exists(select 1 from tournament_trio_wo_reports r where r.board_id = b.id and r.side = mine and r.status = 'pending'),
      'reports', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'side', r.side, 'reason', case when adm or r.side = mine then r.reason end) order by r.created_at), '[]')
                  from tournament_trio_wo_reports r where r.board_id = b.id and r.status = 'pending')
    ) order by b.board_no), '[]') into bj from tournament_boards b where b.match_id = m.id;
  select jsonb_build_object(
      'total', games, 'approved', count(*) filter (where status = 'approved'),
      'a_games', count(*) filter (where status = 'approved' and score_a > score_b),
      'b_games', count(*) filter (where status = 'approved' and score_b > score_a),
      'draws', count(*) filter (where status = 'approved' and score_a = score_b),
      'a_goals', coalesce(sum(score_a) filter (where status = 'approved'), 0),
      'b_goals', coalesce(sum(score_b) filter (where status = 'approved'), 0),
      'walkovers', count(*) filter (where wo_side is not null))
    into sm from tournament_boards where match_id = m.id;
  return jsonb_build_object('trio', true, 'games', games, 'workflow', t.score_workflow, 'deadline_at', m.deadline_at,
    'ended', ended, 'deadline_passed', dl, 'match_status', m.status, 'admin', adm, 'summary', sm, 'my_side', mine,
    'winner_participant_id', m.winner_participant_id, 'decided', exists(select 1 from tournament_trio_decisions where match_id = m.id),
    'swap', case when sw.match_id is not null then jsonb_build_object('at', sw.swapped_at, 'by_admin', sw.swapped_by is distinct from capa) end,
    'can_swap', isopen and sw.match_id is null and open12 = 2 and (adm or (uid = capa and not dl)),
    'a', jsonb_build_object('participant_id', m.participant_a_id, 'is_captain', uid is not null and uid = capa, 'home', true),
    'b', jsonb_build_object('participant_id', m.participant_b_id, 'is_captain', uid is not null and uid = capb, 'home', false),
    'boards', bj);
end $$;

create or replace function public.tournament_trio_top_performers(p_tournament_id uuid)
returns table(member_id uuid, player_name text, team_name text, played bigint, wins bigint, draws bigint, losses bigint, goals_for bigint, goals_against bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (
    select b.a_member_id mid, b.score_a gf, b.score_b ga from tournament_boards b join tournament_matches m on m.id = b.match_id where m.tournament_id = p_tournament_id and b.status = 'approved' and b.wo_side is null
    union all
    select b.b_member_id, b.score_b, b.score_a from tournament_boards b join tournament_matches m on m.id = b.match_id where m.tournament_id = p_tournament_id and b.status = 'approved' and b.wo_side is null)
  select g.mid, public.tournament_member_name(g.mid), tt.team_name, count(*), count(*) filter (where gf > ga), count(*) filter (where gf = ga), count(*) filter (where gf < ga), sum(gf)::bigint, sum(ga)::bigint
  from g join tournament_team_members tm on tm.id = g.mid join tournament_teams tt on tt.id = tm.team_id
  where public.tournament_can_view(p_tournament_id)
  group by g.mid, tt.team_name
  order by 5 desc, (sum(gf) - sum(ga)) desc, 8 desc
$$;

-- grants ---------------------------------------------------------------------------------
revoke all on function public.tournament_trio_order(uuid), public.tournament_trio_fix_slots(uuid), public.tournament_trio_sync_boards(uuid),
  public.tournament_trio_home_balance(), public.tournament_trio_make_boards(), public.tournament_trio_apply_wo(uuid, text, text) from public, anon, authenticated;
revoke all on function public.tournament_trio_set_order(uuid, uuid[]), public.tournament_trio_home_swap(uuid), public.tournament_trio_report_unavailable(uuid, text),
  public.tournament_trio_decide_unavailable(uuid, boolean), public.tournament_trio_admin_walkover(uuid, text, text), public.tournament_trio_replace_player(uuid, uuid, text, text),
  public.tournament_trio_admin_set_game(uuid, int, int, text), public.tournament_team_remove_member(uuid) from public, anon;
grant execute on function public.tournament_trio_set_order(uuid, uuid[]), public.tournament_trio_home_swap(uuid), public.tournament_trio_report_unavailable(uuid, text),
  public.tournament_trio_decide_unavailable(uuid, boolean), public.tournament_trio_admin_walkover(uuid, text, text), public.tournament_trio_replace_player(uuid, uuid, text, text),
  public.tournament_trio_admin_set_game(uuid, int, int, text), public.tournament_team_remove_member(uuid) to authenticated;
revoke all on function public.tournament_rosters(uuid), public.tournament_trio_fixture(uuid), public.tournament_trio_top_performers(uuid) from public;
grant execute on function public.tournament_rosters(uuid), public.tournament_trio_fixture(uuid), public.tournament_trio_top_performers(uuid) to anon, authenticated;
