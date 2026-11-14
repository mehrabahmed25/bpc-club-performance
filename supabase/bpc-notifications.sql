-- Submit-form counts and the notification bell (Nov 2026).

-- counts shown on the submit form, using the same rules as approve_match
create or replace function public.get_submit_limits(p_opponent_name text, p_date date default current_date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me players; d1 date; d2 date; okey text; opp uuid; mkey text; tot int; pair int; pend int; pend_pair int;
begin
  if auth.uid() is null then return null; end if;
  select * into me from players where user_id = auth.uid() and active limit 1;
  if me.id is null then return null; end if;
  d1 := date_trunc('month', coalesce(p_date, current_date))::date; d2 := (d1 + interval '1 month')::date;
  okey := public.normalize_opponent_key(coalesce(p_opponent_name, ''));
  mkey := public.normalize_opponent_key(me.display_name);
  select p.id into opp from players p where public.normalize_opponent_key(p.display_name) = okey and p.active limit 1;
  select count(*) into tot from matches where player_id = me.id and status = 'approved' and counted and match_date >= d1 and match_date < d2;
  select count(*) into pend from matches where player_id = me.id and status = 'pending' and match_date >= d1 and match_date < d2;
  select count(*) into pair from matches m where m.status = 'approved' and m.counted and m.match_date >= d1 and m.match_date < d2
    and ((m.player_id = me.id and m.opponent_key = okey) or (opp is not null and m.player_id = opp and m.opponent_key = mkey));
  select count(*) into pend_pair from matches m where m.status = 'pending' and m.match_date >= d1 and m.match_date < d2
    and ((m.player_id = me.id and m.opponent_key = okey) or (opp is not null and m.player_id = opp and m.opponent_key = mkey));
  return jsonb_build_object('month_total', tot, 'month_pending', pend, 'month_max', 80, 'pair_total', pair, 'pair_pending', pend_pair, 'pair_max', 5,
    'month', to_char(d1, 'FMMonth YYYY'));
end $$;
revoke all on function public.get_submit_limits(text, date) from public, anon;
grant execute on function public.get_submit_limits(text, date) to authenticated;

-- everything that needs the signed-in member's attention, built from live data
create or replace function public.get_my_notifications() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); me players; mykey text; adm boolean := coalesce(public.is_admin(), false); out jsonb := '[]'::jsonb; n int; last timestamptz;
begin
  if uid is null then return out; end if;
  select * into me from players where user_id = uid and active limit 1;
  if me.id is not null then
    mykey := public.normalize_opponent_key(me.display_name);
    -- approved and counted in the last 7 days: one summary
    select count(*), max(approved_at) into n, last from matches where player_id = me.id and status = 'approved' and counted and approved_at > now() - interval '7 days';
    if n > 0 then out := out || jsonb_build_array(jsonb_build_object('id', 'ok-' || extract(epoch from last)::bigint, 'kind', 'good',
      'title', n || ' result' || case when n = 1 then '' else 's' end || ' approved this week', 'body', 'They now count toward the monthly table.', 'at', last, 'link', 'history')); end if;
    -- rejected, or approved but not counted, in the last 14 days: one each
    out := out || coalesce((select jsonb_agg(jsonb_build_object(
        'id', 'm-' || m.id || '-' || m.status,
        'kind', case when m.status = 'rejected' then 'bad' else 'warn' end,
        'title', case when m.status = 'rejected' then 'Result rejected' else 'Approved, but not counted' end,
        'body', 'You ' || m.player_goals || '–' || m.opponent_goals || ' ' || m.opponent_name || coalesce('. ' || nullif(m.exclusion_reason, ''), ''),
        'at', m.approved_at, 'link', 'history'))
      from (select * from matches m where m.player_id = me.id and m.approved_at > now() - interval '14 days'
            and (m.status = 'rejected' or (m.status = 'approved' and not m.counted)) order by m.approved_at desc limit 10) m), '[]'::jsonb);
    -- matches other members logged against me in the last 7 days
    out := out || coalesce((select jsonb_agg(jsonb_build_object(
        'id', 'o-' || m.id, 'kind', 'info', 'title', 'Match logged against you',
        'body', p.display_name || ' ' || m.player_goals || '–' || m.opponent_goals || ' you', 'at', m.approved_at, 'link', 'history'))
      from (select * from matches m where m.status = 'approved' and m.counted and m.opponent_key = mykey and m.player_id <> me.id
            and m.approved_at > now() - interval '7 days' order by m.approved_at desc limit 10) m join players p on p.id = m.player_id), '[]'::jsonb);
  end if;
  -- tournament fixtures due within 48 hours, or overdue in the last day
  out := out || coalesce((select jsonb_agg(jsonb_build_object(
      'id', 'd-' || r.match_id || case when r.deadline_at < now() then '-late' else '' end,
      'kind', case when r.deadline_at < now() then 'bad' else 'warn' end,
      'title', case when r.deadline_at < now() then 'Deadline passed' else 'Fixture due soon' end,
      'body', r.my_name || ' v ' || coalesce(r.opponent_name, 'TBD') || ' · ' || r.tournament_name,
      'at', least(now(), r.deadline_at), 'due', r.deadline_at, 'link', 'tournaments/' || r.tournament_id))
    from public.tournament_my_matches() r
    where r.status in ('scheduled','rejected') and r.deadline_at is not null
      and r.deadline_at < now() + interval '48 hours' and r.deadline_at > now() - interval '24 hours'), '[]'::jsonb);
  -- trio games waiting for my confirmation
  out := out || coalesce((select jsonb_agg(jsonb_build_object(
      'id', 'c-' || b.id, 'kind', 'warn', 'title', 'Confirm a score',
      'body', public.tournament_member_name(b.a_member_id) || ' ' || b.score_a || '–' || b.score_b || ' ' || public.tournament_member_name(b.b_member_id) || ' · Board ' || b.board_no,
      'at', b.submitted_at, 'link', 'tournaments/' || m.tournament_id))
    from tournament_boards b join tournament_matches m on m.id = b.match_id
    where b.status = 'awaiting_opponent' and public.tournament_trio_side(b.id, uid) is not null
      and public.tournament_trio_side(b.id, uid) is distinct from public.tournament_trio_side(b.id, b.submitted_by)), '[]'::jsonb);
  -- captain: choose the MOTM (24h window)
  out := out || coalesce((select jsonb_agg(jsonb_build_object(
      'id', 'mo-' || m.id, 'kind', 'warn', 'title', 'Choose your Man of the Match',
      'body', 'You won ' || m.score_a || '–' || m.score_b || '. Pick before ' || to_char((m.approved_at + interval '24 hours') at time zone 'Asia/Dhaka', 'DD Mon, HH12:MI AM') || '.',
      'at', m.approved_at, 'link', 'tournaments/' || m.tournament_id))
    from tournament_matches m join tournament_teams tt on tt.participant_id = m.winner_participant_id
    where tt.captain_user_id = uid and m.status in ('approved','completed') and m.approved_at > now() - interval '24 hours'
      and public.tournament_trio_games(m.tournament_id) > 1 and not exists (select 1 from tournament_trio_motm x where x.match_id = m.id)), '[]'::jsonb);
  -- captain: home swap still available
  out := out || coalesce((select jsonb_agg(jsonb_build_object(
      'id', 'sw-' || m.id, 'kind', 'info', 'title', 'Home swap available',
      'body', 'You can switch your 1st and 2nd pick once' || case when m.deadline_at is not null then ', until ' || to_char(m.deadline_at at time zone 'Asia/Dhaka', 'DD Mon, HH12:MI AM') else '' end || '.',
      'at', coalesce(m.created_at, now()), 'link', 'tournaments/' || m.tournament_id))
    from tournament_matches m join tournament_teams tt on tt.participant_id = m.participant_a_id
    where tt.captain_user_id = uid and m.status in ('scheduled','rejected') and m.participant_b_id is not null
      and (m.deadline_at is null or m.deadline_at > now()) and public.tournament_trio_games(m.tournament_id) > 1
      and not exists (select 1 from tournament_trio_swaps s where s.match_id = m.id)
      and (select count(*) from tournament_boards b where b.match_id = m.id and b.board_no in (1,2) and b.status = 'scheduled' and b.wo_side is null) = 2), '[]'::jsonb);
  if adm then
    select count(*) into n from matches where status = 'pending';
    if n > 0 then out := out || jsonb_build_array(jsonb_build_object('id', 'a-res-' || n, 'kind', 'admin', 'title', n || ' result' || case when n = 1 then '' else 's' end || ' waiting for approval', 'body', 'Friendly matches submitted by members.', 'at', (select max(submitted_at) from matches where status = 'pending'), 'link', 'admin')); end if;
    select count(*) into n from tournament_boards where status in ('pending','disputed');
    if n > 0 then out := out || jsonb_build_array(jsonb_build_object('id', 'a-brd-' || n, 'kind', 'admin', 'title', n || ' Trio game' || case when n = 1 then '' else 's' end || ' to review', 'body', 'Scores waiting for approval or in dispute.', 'at', now(), 'link', 'admin')); end if;
    select count(*) into n from tournament_trio_wo_reports where status = 'pending';
    if n > 0 then out := out || jsonb_build_array(jsonb_build_object('id', 'a-wo-' || n, 'kind', 'admin', 'title', n || ' walkover report' || case when n = 1 then '' else 's' end, 'body', 'Captains reported a player unavailable.', 'at', (select max(created_at) from tournament_trio_wo_reports where status = 'pending'), 'link', 'admin')); end if;
    select count(*) into n from tournament_matches m where m.status in ('approved','completed') and m.winner_participant_id is not null
      and m.approved_at < now() - interval '24 hours' and public.tournament_trio_games(m.tournament_id) > 1
      and not exists (select 1 from tournament_trio_motm x where x.match_id = m.id)
      and exists (select 1 from tournament_boards b where b.match_id = m.id and b.status = 'approved' and b.wo_side is null);
    if n > 0 then out := out || jsonb_build_array(jsonb_build_object('id', 'a-motm-' || n, 'kind', 'admin', 'title', n || ' MOTM' || case when n = 1 then '' else 's' end || ' to choose', 'body', 'Winning captains did not pick within 24 hours.', 'at', now(), 'link', 'admin')); end if;
  end if;
  return out;
end $$;
revoke all on function public.get_my_notifications() from public, anon;
grant execute on function public.get_my_notifications() to authenticated;
