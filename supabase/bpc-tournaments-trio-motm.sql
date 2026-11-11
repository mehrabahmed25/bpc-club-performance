-- BPC Trio: man of the match per fixture.
-- Once a fixture is final, the winning team's captain picks the MOTM from their own players who played a board
-- (walkover boards do not count). The pick is final. The captain has 24 hours; an admin can pick or change it at any time.

create table if not exists public.tournament_trio_motm(
  match_id uuid primary key references public.tournament_matches(id) on delete cascade,
  member_id uuid not null references public.tournament_team_members(id),
  picked_by uuid, picked_at timestamptz not null default now(), by_admin boolean not null default false);
alter table public.tournament_trio_motm enable row level security;
revoke all on public.tournament_trio_motm from anon, authenticated;

create or replace function public.tournament_trio_set_motm(p_match_id uuid, p_member_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m tournament_matches; adm boolean := coalesce(public.tournament_is_admin(), false); cap uuid; ws text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into m from tournament_matches where id = p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  if m.status not in ('approved','completed') or m.winner_participant_id is null then raise exception 'The MOTM can be chosen once the fixture has a winner'; end if;
  ws := case when m.winner_participant_id = m.participant_a_id then 'a' else 'b' end;
  if not exists(select 1 from tournament_boards b where b.match_id = m.id and b.status = 'approved' and b.wo_side is null
                and ((ws = 'a' and b.a_member_id = p_member_id) or (ws = 'b' and b.b_member_id = p_member_id))) then
    raise exception 'The MOTM must be a player from the winning team who played in this fixture'; end if;
  if not adm then
    select captain_user_id into cap from tournament_teams where participant_id = m.winner_participant_id;
    if cap is distinct from auth.uid() then raise exception 'Only the winning team captain can choose the MOTM'; end if;
    if exists(select 1 from tournament_trio_motm where match_id = m.id) then raise exception 'The MOTM has already been chosen'; end if;
    if m.approved_at is not null and now() > m.approved_at + interval '24 hours' then raise exception 'The 24 hours to choose the MOTM have passed. An admin will choose.'; end if;
  end if;
  insert into tournament_trio_motm(match_id, member_id, picked_by, by_admin) values (m.id, p_member_id, auth.uid(), adm)
    on conflict (match_id) do update set member_id = excluded.member_id, picked_by = excluded.picked_by, picked_at = now(), by_admin = excluded.by_admin;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (m.tournament_id, auth.uid(), 'trio_motm', 'match', m.id::text);
end $$;
revoke all on function public.tournament_trio_set_motm(uuid, uuid) from public, anon;
grant execute on function public.tournament_trio_set_motm(uuid, uuid) to authenticated;
create or replace function public.tournament_trio_fixture(p_match_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m tournament_matches; t tournament_tournaments; uid uuid := auth.uid();
  adm boolean := coalesce(public.tournament_is_admin(), false); games int; ended boolean; dl boolean;
  capa uuid; capb uuid; sw tournament_trio_swaps; open12 int; mine text; bj jsonb; sm jsonb; isopen boolean;
  fin boolean; ws text; mo tournament_trio_motm; mj jsonb; capw uuid;
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
      'a', jsonb_build_object('id', b.a_member_id, 'name', public.tournament_member_name(b.a_member_id), 'user_id', (select user_id from tournament_team_members where id = b.a_member_id)),
      'b', jsonb_build_object('id', b.b_member_id, 'name', public.tournament_member_name(b.b_member_id), 'user_id', (select user_id from tournament_team_members where id = b.b_member_id)),
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
  fin := m.status in ('approved','completed') and m.winner_participant_id is not null;
  ws := case when not fin then null when m.winner_participant_id = m.participant_a_id then 'a' else 'b' end;
  capw := case ws when 'a' then capa when 'b' then capb end;
  select * into mo from tournament_trio_motm where match_id = m.id;
  if fin and mo.match_id is not null and exists(select 1 from tournament_boards b where b.match_id = m.id and b.status = 'approved' and b.wo_side is null
       and ((ws = 'a' and b.a_member_id = mo.member_id) or (ws = 'b' and b.b_member_id = mo.member_id))) then
    mj := jsonb_build_object('member_id', mo.member_id, 'name', public.tournament_member_name(mo.member_id),
      'user_id', (select user_id from tournament_team_members where id = mo.member_id), 'by_admin', mo.by_admin, 'at', mo.picked_at);
  end if;
  return jsonb_build_object('trio', true, 'final', fin, 'winner_side', ws, 'approved_at', m.approved_at, 'round', m.round_number,
    'motm', mj, 'motm_deadline', case when fin and m.approved_at is not null then m.approved_at + interval '24 hours' end,
    'can_pick_motm', fin and (adm or (mj is null and uid is not null and uid = capw and (m.approved_at is null or now() <= m.approved_at + interval '24 hours'))), 'games', games, 'workflow', t.score_workflow, 'deadline_at', m.deadline_at,
    'ended', ended, 'deadline_passed', dl, 'match_status', m.status, 'admin', adm, 'summary', sm, 'my_side', mine,
    'winner_participant_id', m.winner_participant_id, 'decided', exists(select 1 from tournament_trio_decisions where match_id = m.id),
    'swap', case when sw.match_id is not null then jsonb_build_object('at', sw.swapped_at, 'by_admin', sw.swapped_by is distinct from capa) end,
    'can_swap', isopen and sw.match_id is null and open12 = 2 and (adm or (uid = capa and not dl)),
    'a', jsonb_build_object('participant_id', m.participant_a_id, 'is_captain', uid is not null and uid = capa, 'home', true),
    'b', jsonb_build_object('participant_id', m.participant_b_id, 'is_captain', uid is not null and uid = capb, 'home', false),
    'boards', bj);
end $$;

