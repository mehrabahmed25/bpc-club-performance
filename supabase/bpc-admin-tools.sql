-- Admin inbox, match tools and change log (Nov 2026).

create table if not exists public.site_audit_log(
  id bigserial primary key,
  actor uuid references auth.users(id),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());
alter table public.site_audit_log enable row level security;
revoke all on public.site_audit_log from anon, authenticated;

-- Replays the monthly counting rules (same as approve_match) over every approved match of a month,
-- in the order they were approved. Returns how many rows change; p_apply = false only reports.
create or replace function public.admin_recount_month(p_month date, p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d1 date; d2 date; m record; same int; tot int; opp uuid; pname text; want boolean; reason text; changed int := 0; ex jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  d1 := date_trunc('month', p_month)::date; d2 := (d1 + interval '1 month')::date;
  create temp table if not exists _rc(id uuid primary key, player_id uuid, opponent_key text) on commit drop;
  delete from _rc;
  for m in select x.*, p.display_name as pname from matches x join players p on p.id = x.player_id
           where x.status = 'approved' and x.match_date >= d1 and x.match_date < d2
           order by x.approved_at nulls last, x.submitted_at, x.id loop
    select p.id into opp from players p where public.normalize_opponent_key(p.display_name) = m.opponent_key and p.active limit 1;
    select count(*) into same from _rc r where (r.player_id = m.player_id and r.opponent_key = m.opponent_key)
      or (opp is not null and r.player_id = opp and r.opponent_key = public.normalize_opponent_key(m.pname));
    select count(*) into tot from _rc r where r.player_id = m.player_id;
    if same >= 5 then want := false; reason := 'Maximum 5 counted matches against this opponent per month reached';
    elsif tot >= 80 then want := false; reason := 'Monthly maximum of 80 counted matches reached';
    else want := true; reason := ''; end if;
    if want then insert into _rc values (m.id, m.player_id, m.opponent_key); end if;
    if m.counted is distinct from want then
      changed := changed + 1;
      ex := ex || jsonb_build_object('id', m.id, 'date', m.match_date, 'player', m.pname, 'opponent', m.opponent_name, 'score', m.player_goals || '–' || m.opponent_goals, 'counted', want);
      if p_apply then update matches set counted = want, exclusion_reason = reason where id = m.id; end if;
    end if;
  end loop;
  if p_apply and changed > 0 then
    insert into site_audit_log(actor, action, details) values (auth.uid(), 'recount_month', jsonb_build_object('month', to_char(d1, 'YYYY-MM'), 'changed', changed, 'rows', ex));
  end if;
  return jsonb_build_object('month', to_char(d1, 'FMMonth YYYY'), 'changed', changed, 'rows', ex, 'applied', p_apply);
end $$;

create or replace function public.admin_delete_match(p_match_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m matches; pname text; rc jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into m from matches where id = p_match_id for update;
  if not found then raise exception 'Match not found.'; end if;
  select display_name into pname from players where id = m.player_id;
  delete from matches where id = m.id;
  insert into site_audit_log(actor, action, details) values (auth.uid(), 'delete_match', jsonb_build_object(
    'player', pname, 'opponent', m.opponent_name, 'date', m.match_date, 'score', m.player_goals || '–' || m.opponent_goals,
    'status', m.status, 'counted', m.counted, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  rc := public.admin_recount_month(m.match_date, true);
  return jsonb_build_object('deleted', true, 'recount', rc);
end $$;

create or replace function public.get_admin_inbox() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare res jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select jsonb_build_object(
    'pending_results', (select count(*) from matches where status = 'pending'),
    'trio_review', coalesce((select jsonb_agg(x) from (select t.id, t.name, count(*) n from tournament_boards b join tournament_matches m on m.id = b.match_id
        join tournament_tournaments t on t.id = m.tournament_id where b.status in ('pending','disputed') group by t.id, t.name) x), '[]'),
    'walkovers', coalesce((select jsonb_agg(x) from (select t.id, t.name, count(*) n from tournament_trio_wo_reports r join tournament_boards b on b.id = r.board_id
        join tournament_matches m on m.id = b.match_id join tournament_tournaments t on t.id = m.tournament_id where r.status = 'pending' group by t.id, t.name) x), '[]'),
    'motm_missing', coalesce((select jsonb_agg(x) from (select t.id, t.name, count(*) n from tournament_matches m join tournament_tournaments t on t.id = m.tournament_id
        where m.status in ('approved','completed') and m.winner_participant_id is not null and m.approved_at < now() - interval '24 hours'
          and public.tournament_trio_games(m.tournament_id) > 1 and not exists (select 1 from tournament_trio_motm x where x.match_id = m.id)
          and exists (select 1 from tournament_boards b where b.match_id = m.id and b.status = 'approved' and b.wo_side is null)
        group by t.id, t.name) x), '[]'),
    'overdue', coalesce((select jsonb_agg(x) from (select t.id, t.name, count(*) n, min(m.deadline_at) since from tournament_matches m join tournament_tournaments t on t.id = m.tournament_id
        where m.status in ('scheduled','rejected') and m.deadline_at < now() and t.status not in ('completed','archived','cancelled') group by t.id, t.name) x), '[]'),
    'due_soon', coalesce((select jsonb_agg(x) from (select t.id, t.name, count(*) n, min(m.deadline_at) at from tournament_matches m join tournament_tournaments t on t.id = m.tournament_id
        where m.status in ('scheduled','rejected') and m.deadline_at between now() and now() + interval '48 hours' group by t.id, t.name) x), '[]'),
    'log', coalesce((select jsonb_agg(x order by x.created_at desc) from (select l.action, l.details, l.created_at, coalesce(pr.display_name, 'Admin') actor
        from site_audit_log l left join profiles pr on pr.id = l.actor order by l.created_at desc limit 15) x), '[]')
  ) into res;
  return res;
end $$;

revoke all on function public.admin_recount_month(date, boolean), public.admin_delete_match(uuid, text), public.get_admin_inbox() from public, anon;
grant execute on function public.admin_recount_month(date, boolean), public.admin_delete_match(uuid, text), public.get_admin_inbox() to authenticated;
