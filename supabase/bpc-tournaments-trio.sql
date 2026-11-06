-- Trio tournaments: team tournaments where each fixture is several 1v1 games ("boards").
-- Settings live in tournaments.rules_json: team_size (players per team) and games_per_fixture.
-- Tournament data stays separate from friendly-match statistics.

create or replace function public.tournament_trio_games(p_tournament uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(1, coalesce((select nullif(rules_json ->> 'games_per_fixture', '')::int from tournament_tournaments where id = p_tournament), 1))
$$;
create or replace function public.tournament_team_size(p_tournament uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select nullif(rules_json ->> 'team_size', '')::int from tournament_tournaments where id = p_tournament
$$;
create or replace function public.tournament_member_name(p_member uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(nullif(tm.external_name, ''), pr.display_name, cm.name, 'Player')
  from tournament_team_members tm left join profiles pr on pr.id = tm.user_id left join cobeg_members cm on cm.id = tm.cobeg_member_id
  where tm.id = p_member
$$;

create table if not exists public.tournament_lineups(
  match_id uuid not null references public.tournament_matches(id) on delete cascade,
  participant_id uuid not null references public.tournament_participants(id) on delete cascade,
  slots uuid[] not null,
  locked_by uuid, locked_at timestamptz not null default now(),
  primary key (match_id, participant_id));
create table if not exists public.tournament_boards(
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.tournament_matches(id) on delete cascade,
  board_no int not null,
  a_member_id uuid not null references public.tournament_team_members(id),
  b_member_id uuid not null references public.tournament_team_members(id),
  score_a int check (score_a between 0 and 99), score_b int check (score_b between 0 and 99),
  status text not null default 'scheduled' check (status in ('scheduled','awaiting_opponent','pending','approved','disputed')),
  submitted_by uuid, submitted_at timestamptz, confirmed_by uuid, confirmed_at timestamptz,
  approved_by uuid, approved_at timestamptz, review_reason text,
  unique (match_id, board_no));
create table if not exists public.tournament_trio_decisions(
  match_id uuid primary key references public.tournament_matches(id) on delete cascade,
  winner_participant_id uuid references public.tournament_participants(id),
  reason text, decided_by uuid, decided_at timestamptz not null default now());
alter table public.tournament_lineups enable row level security;
alter table public.tournament_boards enable row level security;
alter table public.tournament_trio_decisions enable row level security;
revoke all on public.tournament_lineups, public.tournament_boards, public.tournament_trio_decisions from anon, authenticated;

-- which side of a board a user is on (player or team captain)
create or replace function public.tournament_trio_side(p_board uuid, p_uid uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_uid is null then null
    when p_uid = (select user_id from tournament_team_members where id = b.a_member_id)
      or p_uid = (select captain_user_id from tournament_teams where participant_id = m.participant_a_id) then 'a'
    when p_uid = (select user_id from tournament_team_members where id = b.b_member_id)
      or p_uid = (select captain_user_id from tournament_teams where participant_id = m.participant_b_id) then 'b' end
  from tournament_boards b join tournament_matches m on m.id = b.match_id where b.id = p_board
$$;

-- one fixture, everything the page needs (opponent lineup stays hidden until both are locked)
create or replace function public.tournament_trio_fixture(p_match_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m tournament_matches; t tournament_tournaments; uid uuid := auth.uid();
  adm boolean := coalesce(public.tournament_is_admin(), false); games int; ended boolean;
  capa uuid; capb uuid; la uuid[]; lb uuid[]; lka boolean; lkb boolean; bothl boolean;
  ra jsonb; rb jsonb; bj jsonb; sm jsonb; dl boolean;
begin
  select * into m from tournament_matches where id = p_match_id;
  if not found then raise exception 'Match not found'; end if;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if not public.tournament_can_view(t.id) then raise exception 'Not allowed'; end if;
  games := public.tournament_trio_games(t.id);
  if games < 2 or m.participant_b_id is null then return jsonb_build_object('trio', false); end if;
  ended := t.status in ('completed','archived','cancelled');
  dl := m.deadline_at is not null and now() > m.deadline_at;
  select captain_user_id into capa from tournament_teams where participant_id = m.participant_a_id;
  select captain_user_id into capb from tournament_teams where participant_id = m.participant_b_id;
  select slots into la from tournament_lineups where match_id = m.id and participant_id = m.participant_a_id;
  select slots into lb from tournament_lineups where match_id = m.id and participant_id = m.participant_b_id;
  lka := la is not null; lkb := lb is not null; bothl := lka and lkb;
  select coalesce(jsonb_agg(jsonb_build_object('id', tm.id, 'name', public.tournament_member_name(tm.id), 'captain', tm.role = 'captain') order by (tm.role = 'captain') desc, tm.joined_at), '[]')
    into ra from tournament_team_members tm join tournament_teams tt on tt.id = tm.team_id where tt.participant_id = m.participant_a_id and tm.status = 'active';
  select coalesce(jsonb_agg(jsonb_build_object('id', tm.id, 'name', public.tournament_member_name(tm.id), 'captain', tm.role = 'captain') order by (tm.role = 'captain') desc, tm.joined_at), '[]')
    into rb from tournament_team_members tm join tournament_teams tt on tt.id = tm.team_id where tt.participant_id = m.participant_b_id and tm.status = 'active';
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'board_no', b.board_no, 'status', b.status, 'score_a', b.score_a, 'score_b', b.score_b,
      'a', jsonb_build_object('id', b.a_member_id, 'name', public.tournament_member_name(b.a_member_id)),
      'b', jsonb_build_object('id', b.b_member_id, 'name', public.tournament_member_name(b.b_member_id)),
      'can_submit', not ended and m.status in ('scheduled','rejected') and b.status = 'scheduled' and t.score_workflow <> 'admin_entered' and not dl
                    and public.tournament_trio_side(b.id, uid) is not null,
      'can_confirm', not ended and b.status = 'awaiting_opponent' and t.score_workflow = 'participant_opponent_admin'
                    and public.tournament_trio_side(b.id, uid) is not null and b.submitted_by is distinct from uid
                    and public.tournament_trio_side(b.id, uid) is distinct from public.tournament_trio_side(b.id, b.submitted_by)
    ) order by b.board_no), '[]') into bj from tournament_boards b where b.match_id = m.id;
  select jsonb_build_object(
      'total', games, 'approved', count(*) filter (where status = 'approved'),
      'a_games', count(*) filter (where status = 'approved' and score_a > score_b),
      'b_games', count(*) filter (where status = 'approved' and score_b > score_a),
      'draws', count(*) filter (where status = 'approved' and score_a = score_b),
      'a_goals', coalesce(sum(score_a) filter (where status = 'approved'), 0),
      'b_goals', coalesce(sum(score_b) filter (where status = 'approved'), 0))
    into sm from tournament_boards where match_id = m.id;
  return jsonb_build_object('trio', true, 'games', games, 'workflow', t.score_workflow, 'deadline_at', m.deadline_at,
    'ended', ended, 'deadline_passed', dl, 'match_status', m.status, 'admin', adm, 'summary', sm,
    'winner_participant_id', m.winner_participant_id, 'decided', exists(select 1 from tournament_trio_decisions where match_id = m.id),
    'a', jsonb_build_object('participant_id', m.participant_a_id, 'locked', lka, 'roster', ra,
          'can_lineup', not ended and not lka and m.status in ('scheduled','rejected') and (adm or uid = capa) and (adm or not dl),
          'is_captain', uid is not null and uid = capa,
          'slots', case when lka and (bothl or adm or uid = capa) then (select jsonb_agg(jsonb_build_object('id', s, 'name', public.tournament_member_name(s)) order by o) from unnest(la) with ordinality x(s, o)) end),
    'b', jsonb_build_object('participant_id', m.participant_b_id, 'locked', lkb, 'roster', rb,
          'can_lineup', not ended and not lkb and m.status in ('scheduled','rejected') and (adm or uid = capb) and (adm or not dl),
          'is_captain', uid is not null and uid = capb,
          'slots', case when lkb and (bothl or adm or uid = capb) then (select jsonb_agg(jsonb_build_object('id', s, 'name', public.tournament_member_name(s)) order by o) from unnest(lb) with ordinality x(s, o)) end),
    'boards', bj);
end $$;

-- captain (or admin) locks a lineup; boards are created once both sides have locked
create or replace function public.tournament_trio_set_lineup(p_match_id uuid, p_participant_id uuid, p_slots uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m tournament_matches; t tournament_tournaments; games int; cap uuid; sa uuid[]; sb uuid[]; i int; ok int;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into m from tournament_matches where id = p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  select * into t from tournament_tournaments where id = m.tournament_id;
  games := public.tournament_trio_games(t.id);
  if games < 2 then raise exception 'This is not a multi-game tournament'; end if;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if p_participant_id not in (m.participant_a_id, m.participant_b_id) then raise exception 'That team is not in this fixture'; end if;
  if m.status not in ('scheduled','rejected') then raise exception 'This fixture is no longer open'; end if;
  select captain_user_id into cap from tournament_teams where participant_id = p_participant_id;
  if not public.tournament_is_admin() then
    if cap is distinct from auth.uid() then raise exception 'Only the team captain can set the lineup'; end if;
    if m.deadline_at is not null and now() > m.deadline_at then raise exception 'The deadline for this fixture has passed. Please contact an administrator.'; end if;
  end if;
  if exists(select 1 from tournament_lineups where match_id = m.id and participant_id = p_participant_id) then raise exception 'This lineup is already locked'; end if;
  if cardinality(p_slots) <> games then raise exception 'Choose exactly % players, one for each board', games; end if;
  if (select count(distinct s) from unnest(p_slots) s) <> games then raise exception 'Each player can only be used once'; end if;
  select count(*) into ok from tournament_team_members tm join tournament_teams tt on tt.id = tm.team_id
    where tt.participant_id = p_participant_id and tm.status = 'active' and tm.id = any(p_slots);
  if ok <> games then raise exception 'Every board player must be on the team roster'; end if;
  insert into tournament_lineups(match_id, participant_id, slots, locked_by) values (m.id, p_participant_id, p_slots, auth.uid());
  select slots into sa from tournament_lineups where match_id = m.id and participant_id = m.participant_a_id;
  select slots into sb from tournament_lineups where match_id = m.id and participant_id = m.participant_b_id;
  if sa is not null and sb is not null then
    for i in 1..games loop
      insert into tournament_boards(match_id, board_no, a_member_id, b_member_id) values (m.id, i, sa[i], sb[i]) on conflict do nothing;
    end loop;
  end if;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (m.tournament_id, auth.uid(), 'trio_lineup_locked', 'match', m.id::text);
end $$;

create or replace function public.tournament_trio_admin_reset_lineup(p_match_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m tournament_matches;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into m from tournament_matches where id = p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  if exists(select 1 from tournament_boards where match_id = m.id and status = 'approved') then raise exception 'Games have already been approved for this fixture'; end if;
  delete from tournament_boards where match_id = m.id;
  delete from tournament_lineups where match_id = m.id;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id, reason) values (m.tournament_id, auth.uid(), 'trio_lineup_reset', 'match', m.id::text, p_reason);
end $$;

-- compute the fixture result from its approved games (internal)
create or replace function public.tournament_trio_finalize(p_match_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m tournament_matches; games int; n int; ga int; gb int; pa bigint; pb bigint; w uuid; d uuid;
begin
  select * into m from tournament_matches where id = p_match_id for update;
  if not found then return; end if;
  games := public.tournament_trio_games(m.tournament_id);
  select count(*), count(*) filter (where score_a > score_b), count(*) filter (where score_b > score_a), coalesce(sum(score_a), 0), coalesce(sum(score_b), 0)
    into n, ga, gb, pa, pb from tournament_boards where match_id = m.id and status = 'approved';
  if n < games then
    if m.status = 'approved' then update tournament_matches set status = 'scheduled', winner_participant_id = null, approved_by = null, approved_at = null, updated_at = now() where id = m.id; end if;
    return;
  end if;
  if ga > gb then w := m.participant_a_id; elsif gb > ga then w := m.participant_b_id;
  elsif pa > pb then w := m.participant_a_id; elsif pb > pa then w := m.participant_b_id;
  else select winner_participant_id into d from tournament_trio_decisions where match_id = m.id; w := d; end if;
  update tournament_matches set score_a = ga, score_b = gb, winner_participant_id = w, status = 'approved',
    approved_by = coalesce(auth.uid(), approved_by), approved_at = now(), result_version = result_version + 1, updated_at = now() where id = m.id;
end $$;

create or replace function public.tournament_trio_submit_game(p_board_id uuid, p_score_a int, p_score_b int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; m tournament_matches; t tournament_tournaments;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_score_a is null or p_score_b is null or p_score_a < 0 or p_score_b < 0 or p_score_a > 99 or p_score_b > 99 then raise exception 'Enter a whole-number score from 0 to 99 for bothl players'; end if;
  select * into b from tournament_boards where id = p_board_id for update;
  if not found then raise exception 'Game not found'; end if;
  select * into m from tournament_matches where id = b.match_id;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if t.score_workflow = 'admin_entered' then raise exception 'This tournament accepts results from admins only'; end if;
  if b.status <> 'scheduled' then raise exception 'This game is not accepting a score'; end if;
  if m.deadline_at is not null and now() > m.deadline_at then raise exception 'The deadline for this fixture has passed. Please contact an administrator.'; end if;
  if public.tournament_trio_side(b.id, auth.uid()) is null then raise exception 'Only the players in this game or their captains can submit the score'; end if;
  update tournament_boards set score_a = p_score_a, score_b = p_score_b, submitted_by = auth.uid(), submitted_at = now(),
    status = case when t.score_workflow = 'participant_opponent_admin' then 'awaiting_opponent' else 'pending' end where id = b.id;
end $$;

create or replace function public.tournament_trio_confirm_game(p_board_id uuid, p_confirm boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; m tournament_matches; t tournament_tournaments; me text; sub text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into b from tournament_boards where id = p_board_id for update;
  if not found or b.status <> 'awaiting_opponent' then raise exception 'This game is not waiting for confirmation'; end if;
  select * into m from tournament_matches where id = b.match_id;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  me := public.tournament_trio_side(b.id, auth.uid()); sub := public.tournament_trio_side(b.id, b.submitted_by);
  if me is null or me = sub or b.submitted_by = auth.uid() then raise exception 'Only the opposing player or captain can confirm'; end if;
  if p_confirm then update tournament_boards set status = 'pending', confirmed_by = auth.uid(), confirmed_at = now() where id = b.id;
  else update tournament_boards set status = 'disputed', review_reason = p_reason where id = b.id; end if;
end $$;

-- admin: approve or reject a submitted game
create or replace function public.tournament_trio_review_game(p_board_id uuid, p_decision text, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; m tournament_matches; t tournament_tournaments;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if p_decision not in ('approve','reject') then raise exception 'Decision must be approve or reject'; end if;
  select * into b from tournament_boards where id = p_board_id for update;
  if not found then raise exception 'Game not found'; end if;
  select * into m from tournament_matches where id = b.match_id;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if b.status not in ('pending','disputed','awaiting_opponent') then raise exception 'This game is not waiting for review'; end if;
  if p_decision = 'approve' then
    if t.score_workflow = 'participant_opponent_admin' and b.confirmed_at is null and b.status <> 'disputed' then raise exception 'Opponent confirmation is required first, or use Enter score'; end if;
    update tournament_boards set status = 'approved', approved_by = auth.uid(), approved_at = now(), review_reason = p_reason where id = b.id;
  else
    update tournament_boards set status = 'scheduled', score_a = null, score_b = null, submitted_by = null, submitted_at = null, confirmed_by = null, confirmed_at = null, review_reason = p_reason where id = b.id;
  end if;
  perform public.tournament_trio_finalize(b.match_id);
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id, reason) values (m.tournament_id, auth.uid(), 'trio_game_'||p_decision, 'board', b.id::text, p_reason);
end $$;

-- admin: enter or correct a game score and approve it
create or replace function public.tournament_trio_admin_set_game(p_board_id uuid, p_score_a int, p_score_b int, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b tournament_boards; m tournament_matches; t tournament_tournaments;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if p_score_a is null or p_score_b is null or p_score_a < 0 or p_score_b < 0 or p_score_a > 99 or p_score_b > 99 then raise exception 'Enter a whole-number score from 0 to 99 for bothl players'; end if;
  select * into b from tournament_boards where id = p_board_id for update;
  if not found then raise exception 'Game not found'; end if;
  select * into m from tournament_matches where id = b.match_id;
  select * into t from tournament_tournaments where id = m.tournament_id;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  update tournament_boards set score_a = p_score_a, score_b = p_score_b, status = 'approved', submitted_by = coalesce(submitted_by, auth.uid()),
    submitted_at = coalesce(submitted_at, now()), approved_by = auth.uid(), approved_at = now(), review_reason = p_reason where id = b.id;
  perform public.tournament_trio_finalize(b.match_id);
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id, reason) values (m.tournament_id, auth.uid(), 'trio_game_admin_set', 'board', b.id::text, p_reason);
end $$;

-- admin: pick the winner of a fixture that finished level on games and goals
create or replace function public.tournament_trio_admin_decide(p_match_id uuid, p_winner uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m tournament_matches;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into m from tournament_matches where id = p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  if p_winner is not null and p_winner not in (m.participant_a_id, m.participant_b_id) then raise exception 'Winner must be one of the two teams'; end if;
  insert into tournament_trio_decisions(match_id, winner_participant_id, reason, decided_by) values (m.id, p_winner, p_reason, auth.uid())
    on conflict (match_id) do update set winner_participant_id = excluded.winner_participant_id, reason = excluded.reason, decided_by = excluded.decided_by, decided_at = now();
  perform public.tournament_trio_finalize(m.id);
end $$;

create or replace function public.tournament_trio_top_performers(p_tournament_id uuid)
returns table(member_id uuid, player_name text, team_name text, played bigint, wins bigint, draws bigint, losses bigint, goals_for bigint, goals_against bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (
    select b.a_member_id mid, b.score_a gf, b.score_b ga from tournament_boards b join tournament_matches m on m.id = b.match_id where m.tournament_id = p_tournament_id and b.status = 'approved'
    union all
    select b.b_member_id, b.score_b, b.score_a from tournament_boards b join tournament_matches m on m.id = b.match_id where m.tournament_id = p_tournament_id and b.status = 'approved')
  select g.mid, public.tournament_member_name(g.mid), tt.team_name, count(*), count(*) filter (where gf > ga), count(*) filter (where gf = ga), count(*) filter (where gf < ga), sum(gf)::bigint, sum(ga)::bigint
  from g join tournament_team_members tm on tm.id = g.mid join tournament_teams tt on tt.id = tm.team_id
  where public.tournament_can_view(p_tournament_id)
  group by g.mid, tt.team_name
  order by 5 desc, (sum(gf) - sum(ga)) desc, 8 desc
$$;

-- guard rails ---------------------------------------------------------------
-- single-score submissions are not allowed for multi-game tournaments
create or replace function public.tournament_block_trio_submission() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare tid uuid; g int;
begin
  select tournament_id into tid from tournament_matches where id = new.match_id;
  g := public.tournament_trio_games(tid);
  if g > 1 then raise exception 'This tournament is played as % games per fixture. Enter the individual games instead.', g; end if;
  return new;
end $$;
drop trigger if exists tournament_block_trio_submission on public.tournament_result_submissions;
create trigger tournament_block_trio_submission before insert on public.tournament_result_submissions for each row execute function public.tournament_block_trio_submission();

-- every confirmed team must have exactly team_size players before fixtures are drawn
create or replace function public.tournament_check_team_sizes() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare sz int; bad text;
begin
  sz := public.tournament_team_size(new.tournament_id);
  if sz is null then return new; end if;
  select string_agg(tt.team_name || ' (' || n || '/' || sz || ')', ', ') into bad from (
    select tt.id, tt.team_name, (select count(*) from tournament_team_members tm where tm.team_id = tt.id and tm.status = 'active') n
    from tournament_teams tt join tournament_participants p on p.id = tt.participant_id
    where tt.tournament_id = new.tournament_id and p.status = 'confirmed') tt where n <> sz;
  if bad is not null then raise exception 'Every team needs exactly % players before fixtures can be made. Check: %', sz, bad; end if;
  return new;
end $$;
drop trigger if exists tournament_check_team_sizes on public.tournament_pairing_runs;
create trigger tournament_check_team_sizes before insert on public.tournament_pairing_runs for each row execute function public.tournament_check_team_sizes();

-- roster: size cap, no player in two teams, locked once registration closes
create or replace function public.tournament_team_add_member(p_team_id uuid, p_user_id uuid default null, p_cobeg_member_id uuid default null, p_external_name text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_team tournament_teams%rowtype; v_t tournament_tournaments%rowtype; v_id uuid; v_sz int; v_n int;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if num_nonnulls(p_user_id, p_cobeg_member_id, nullif(trim(p_external_name), '')) <> 1 then raise exception 'Provide exactly one member identity'; end if;
  select * into v_team from tournament_teams where id = p_team_id for update;
  if not found then raise exception 'Team not found'; end if;
  select * into v_t from tournament_tournaments where id = v_team.tournament_id;
  if not public.tournament_is_admin() then
    if v_team.captain_user_id <> auth.uid() then raise exception 'Only the captain or an administrator may manage this roster'; end if;
    if v_t.status <> 'registration_open' or (v_t.registration_deadline is not null and v_t.registration_deadline < now()) then raise exception 'Rosters are locked because registration has closed'; end if;
  end if;
  if exists(select 1 from tournament_participants where id = v_team.participant_id and status not in ('pending','confirmed')) then raise exception 'Team is not active'; end if;
  v_sz := public.tournament_team_size(v_team.tournament_id);
  select count(*) into v_n from tournament_team_members where team_id = p_team_id and status = 'active';
  if v_sz is not null and v_n >= v_sz then raise exception 'This team already has % players', v_sz; end if;
  if exists(select 1 from tournament_team_members tm join tournament_teams tt on tt.id = tm.team_id
            where tt.tournament_id = v_team.tournament_id and tm.status = 'active'
              and ((p_user_id is not null and tm.user_id = p_user_id) or (p_cobeg_member_id is not null and tm.cobeg_member_id = p_cobeg_member_id)
                   or (p_user_id is null and p_cobeg_member_id is null and lower(tm.external_name) = lower(trim(p_external_name)))))
  then raise exception 'That player is already in a team in this tournament'; end if;
  insert into tournament_team_members(team_id, user_id, cobeg_member_id, external_name)
    values (p_team_id, p_user_id, p_cobeg_member_id, case when p_user_id is null and p_cobeg_member_id is null then trim(p_external_name) end) returning id into v_id;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (v_team.tournament_id, auth.uid(), 'team_member_added', 'team_member', v_id::text);
  return v_id;
end $$;

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
  if exists(select 1 from tournament_lineups l where p_member_id = any(l.slots)) then raise exception 'That player is in a fixture lineup and cannot be removed'; end if;
  update tournament_team_members set status = 'removed', left_at = now() where id = p_member_id;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (v_team.tournament_id, auth.uid(), 'team_member_removed', 'team_member', p_member_id::text);
end $$;

-- standings: games difference first, then total goals in the games, as the tie-break
create or replace function public.tournament_standings_for_stage(p_stage_id uuid)
returns table(participant_id uuid, entrant_name text, played bigint, wins bigint, draws bigint, losses bigint, score_for bigint, score_against bigint, score_difference bigint, points numeric)
language sql stable security definer set search_path = public, pg_temp as $$
 with st as (select s.id,s.tournament_id,t.scoring_config_json from public.tournament_stages s join public.tournament_tournaments t on t.id=s.tournament_id where s.id=p_stage_id and public.tournament_can_view(s.tournament_id)),
 entrants as (
  select e.participant_id,coalesce(tt.team_name,nullif(p.external_name,''),pr.display_name,cm.name,'Entrant') entrant_name,st.scoring_config_json
  from public.tournament_stage_entries e join st on st.id=e.stage_id
  join public.tournament_participants p on p.id=e.participant_id and p.status='confirmed'
  left join public.tournament_teams tt on tt.participant_id=p.id
  left join public.profiles pr on pr.id=p.user_id left join public.cobeg_members cm on cm.id=p.cobeg_member_id
  where e.entry_status in ('active','qualified')
 ), calc as (
  select e.participant_id,e.entrant_name,
  count(m.id) filter(where m.status='approved') played,
  count(m.id) filter(where m.status='approved' and m.winner_participant_id=e.participant_id) wins,
  count(m.id) filter(where m.status='approved' and m.winner_participant_id is null and m.score_a=m.score_b) draws,
  count(m.id) filter(where m.status='approved' and m.winner_participant_id is not null and m.winner_participant_id<>e.participant_id) losses,
  coalesce(sum(case when m.status='approved' and m.participant_a_id=e.participant_id then m.score_a when m.status='approved' and m.participant_b_id=e.participant_id then m.score_b else 0 end),0) sf,
  coalesce(sum(case when m.status='approved' and m.participant_a_id=e.participant_id then m.score_b when m.status='approved' and m.participant_b_id=e.participant_id then m.score_a else 0 end),0) sa,
  coalesce(sum(case when m.status='approved' and m.winner_participant_id=e.participant_id then coalesce((e.scoring_config_json->>'win')::numeric,3) when m.status='approved' and m.winner_participant_id is null and m.score_a=m.score_b then coalesce((e.scoring_config_json->>'draw')::numeric,1) else 0 end),0) pts,
  coalesce((select sum(case when bm.participant_a_id=e.participant_id then b.score_a-b.score_b else b.score_b-b.score_a end)
            from public.tournament_boards b join public.tournament_matches bm on bm.id=b.match_id
            where bm.stage_id=p_stage_id and (bm.participant_a_id=e.participant_id or bm.participant_b_id=e.participant_id) and b.status='approved' and bm.status='approved'),0) gd
  from entrants e left join public.tournament_matches m on m.stage_id=p_stage_id and (m.participant_a_id=e.participant_id or m.participant_b_id=e.participant_id)
  group by e.participant_id,e.entrant_name,e.scoring_config_json
 )
 select participant_id,entrant_name,played,wins,draws,losses,sf,sa,sf-sa,pts from calc order by pts desc,sf-sa desc,gd desc,sf desc,wins desc,entrant_name
$$;

revoke all on function public.tournament_trio_games(uuid), public.tournament_team_size(uuid), public.tournament_member_name(uuid), public.tournament_trio_side(uuid, uuid),
  public.tournament_trio_finalize(uuid), public.tournament_block_trio_submission(), public.tournament_check_team_sizes() from public, anon, authenticated;
revoke all on function public.tournament_trio_fixture(uuid), public.tournament_trio_top_performers(uuid) from public;
grant execute on function public.tournament_trio_fixture(uuid), public.tournament_trio_top_performers(uuid) to anon, authenticated;
revoke all on function public.tournament_trio_set_lineup(uuid, uuid, uuid[]), public.tournament_trio_admin_reset_lineup(uuid, text), public.tournament_trio_submit_game(uuid, int, int),
  public.tournament_trio_confirm_game(uuid, boolean, text), public.tournament_trio_review_game(uuid, text, text), public.tournament_trio_admin_set_game(uuid, int, int, text),
  public.tournament_trio_admin_decide(uuid, uuid, text), public.tournament_team_remove_member(uuid) from public, anon;
grant execute on function public.tournament_trio_set_lineup(uuid, uuid, uuid[]), public.tournament_trio_admin_reset_lineup(uuid, text), public.tournament_trio_submit_game(uuid, int, int),
  public.tournament_trio_confirm_game(uuid, boolean, text), public.tournament_trio_review_game(uuid, text, text), public.tournament_trio_admin_set_game(uuid, int, int, text),
  public.tournament_trio_admin_decide(uuid, uuid, text), public.tournament_team_remove_member(uuid) to authenticated;

-- rosters (read) and admin team creation ---------------------------------------
create or replace function public.tournament_rosters(p_tournament_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); adm boolean := coalesce(public.tournament_is_admin(), false); t tournament_tournaments; sz int; open_reg boolean; res jsonb;
begin
  select * into t from tournament_tournaments where id = p_tournament_id;
  if not found or not public.tournament_can_view(p_tournament_id) then raise exception 'Not allowed'; end if;
  sz := public.tournament_team_size(p_tournament_id);
  open_reg := t.status = 'registration_open' and (t.registration_deadline is null or t.registration_deadline >= now());
  select coalesce(jsonb_agg(jsonb_build_object(
      'team_id', tt.id, 'participant_id', tt.participant_id, 'team_name', tt.team_name, 'status', p.status,
      'is_captain', uid is not null and tt.captain_user_id = uid,
      'can_manage', not (t.status in ('completed','archived','cancelled')) and (adm or (uid is not null and tt.captain_user_id = uid and open_reg)),
      'size', sz,
      'members', (select coalesce(jsonb_agg(jsonb_build_object('id', tm.id, 'name', public.tournament_member_name(tm.id), 'captain', tm.role = 'captain', 'user_id', tm.user_id) order by (tm.role = 'captain') desc, tm.joined_at), '[]')
                  from tournament_team_members tm where tm.team_id = tt.id and tm.status = 'active')
    ) order by tt.team_name), '[]') into res
  from tournament_teams tt join tournament_participants p on p.id = tt.participant_id
  where tt.tournament_id = p_tournament_id and p.status not in ('withdrawn','rejected','disqualified')
    and (adm or p.status = 'confirmed' or tt.captain_user_id = uid);
  return res;
end $$;

create or replace function public.tournament_admin_create_team(p_tournament_id uuid, p_team_name text, p_captain_user_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tournament_tournaments; pid uuid; tid uuid;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into t from tournament_tournaments where id = p_tournament_id for update;
  if not found or t.competition_type <> 'team' then raise exception 'This is not a team tournament'; end if;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if length(trim(p_team_name)) not between 2 and 100 then raise exception 'Team name must be 2–100 characters'; end if;
  if exists(select 1 from tournament_teams where tournament_id = p_tournament_id and lower(team_name) = lower(trim(p_team_name))) then raise exception 'That team name is already used'; end if;
  if exists(select 1 from tournament_team_members tm join tournament_teams x on x.id = tm.team_id where x.tournament_id = p_tournament_id and tm.status = 'active' and tm.user_id = p_captain_user_id) then raise exception 'That player is already in a team in this tournament'; end if;
  insert into tournament_participants(tournament_id, entrant_type, user_id, registration_source, status, created_by, approved_by, approved_at)
    values (p_tournament_id, 'team', p_captain_user_id, 'admin', 'confirmed', auth.uid(), auth.uid(), now()) returning id into pid;
  insert into tournament_teams(tournament_id, participant_id, team_name, captain_user_id) values (p_tournament_id, pid, trim(p_team_name), p_captain_user_id) returning id into tid;
  insert into tournament_team_members(team_id, user_id, role) values (tid, p_captain_user_id, 'captain');
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (p_tournament_id, auth.uid(), 'team_created_by_admin', 'team', tid::text);
  return tid;
end $$;

revoke all on function public.tournament_rosters(uuid) from public;
grant execute on function public.tournament_rosters(uuid) to anon, authenticated;
revoke all on function public.tournament_admin_create_team(uuid, text, uuid) from public, anon;
grant execute on function public.tournament_admin_create_team(uuid, text, uuid) to authenticated;

-- Reuse after a team is removed: players on withdrawn or rejected teams no longer block new teams.
-- (tournament_admin_create_team and tournament_team_add_member now call this helper in their duplicate check.)
create or replace function public.tournament_player_on_live_team(p_tournament uuid, p_user uuid, p_cobeg uuid, p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(
    select 1 from tournament_team_members tm
    join tournament_teams tt on tt.id = tm.team_id
    join tournament_participants p on p.id = tt.participant_id
    where tt.tournament_id = p_tournament and tm.status = 'active' and p.status not in ('withdrawn','rejected')
      and ((p_user is not null and tm.user_id = p_user)
        or (p_cobeg is not null and tm.cobeg_member_id = p_cobeg)
        or (p_user is null and p_cobeg is null and p_name is not null and lower(tm.external_name) = lower(trim(p_name)))))
$$;
revoke all on function public.tournament_player_on_live_team(uuid, uuid, uuid, text) from public, anon, authenticated;
