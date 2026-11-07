-- BPC Trio team draft: pool, lottery pick order, captain picks, lottery pick, substitute pool.
-- Applies on top of bpc-tournaments-trio.sql. Apply once in the Supabase SQL editor (or as a migration).

create table if not exists public.tournament_drafts(
  tournament_id uuid primary key references public.tournament_tournaments(id) on delete cascade,
  status text not null default 'setup' check (status in ('setup','picking','lottery','complete')),
  team_order uuid[],
  pick_index int not null default 0,
  drawn_at timestamptz, lottery_at timestamptz,
  created_by uuid, created_at timestamptz not null default now());

create table if not exists public.tournament_draft_pool(
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  user_id uuid, external_name text,
  team_id uuid references public.tournament_teams(id),
  member_id uuid references public.tournament_team_members(id),
  how text check (how in ('captain_pick','lottery','substitute')),
  pick_no int, assigned_at timestamptz,
  added_by uuid, created_at timestamptz not null default now(),
  check (num_nonnulls(user_id, nullif(trim(external_name), '')) = 1));
create unique index if not exists tournament_draft_pool_user_uq on public.tournament_draft_pool(tournament_id, user_id) where user_id is not null;
create unique index if not exists tournament_draft_pool_name_uq on public.tournament_draft_pool(tournament_id, lower(trim(external_name))) where external_name is not null;

create table if not exists public.tournament_sub_requests(
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament_tournaments(id) on delete cascade,
  team_id uuid not null references public.tournament_teams(id),
  out_member_id uuid not null references public.tournament_team_members(id),
  pool_id uuid not null references public.tournament_draft_pool(id),
  reason text,
  requested_by uuid not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid, decided_at timestamptz, created_at timestamptz not null default now());

alter table public.tournament_drafts enable row level security;
alter table public.tournament_draft_pool enable row level security;
alter table public.tournament_sub_requests enable row level security;
revoke all on public.tournament_drafts, public.tournament_draft_pool, public.tournament_sub_requests from anon, authenticated;

-- live (confirmed) teams of a tournament
create or replace function public.tournament_draft_teams(p_tournament uuid)
returns table(team_id uuid, team_name text, captain_user_id uuid, participant_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select tt.id, tt.team_name, tt.captain_user_id, tt.participant_id
  from tournament_teams tt join tournament_participants p on p.id = tt.participant_id
  where tt.tournament_id = p_tournament and p.status = 'confirmed'
$$;

-- squads are filled by the draft once it exists: only admins (or the draft functions) may change rosters
create or replace function public.tournament_block_manual_roster() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare tid uuid;
begin
  if tg_op = 'INSERT' and new.role = 'captain' then return new; end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  select tournament_id into tid from tournament_teams where id = new.team_id;
  if exists(select 1 from tournament_drafts where tournament_id = tid)
     and coalesce(current_setting('bpc.draft', true), '') <> '1'
     and not coalesce(public.tournament_is_admin(), false) then
    raise exception 'Squads are filled through the draft. Ask an admin for a substitute.';
  end if;
  return new;
end $$;
drop trigger if exists tournament_block_manual_roster on public.tournament_team_members;
create trigger tournament_block_manual_roster before insert or update on public.tournament_team_members
  for each row execute function public.tournament_block_manual_roster();

-- internal: put a pool entry on a team
create or replace function public.tournament_draft_assign(p_pool uuid, p_team uuid, p_how text, p_no int) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pe tournament_draft_pool; mid uuid;
begin
  select * into pe from tournament_draft_pool where id = p_pool for update;
  if not found or pe.team_id is not null then raise exception 'That player is no longer available'; end if;
  perform set_config('bpc.draft', '1', true);
  insert into tournament_team_members(team_id, user_id, external_name)
    values (p_team, pe.user_id, case when pe.user_id is null then trim(pe.external_name) end) returning id into mid;
  update tournament_draft_pool set team_id = p_team, member_id = mid, how = p_how, pick_no = p_no, assigned_at = now() where id = p_pool;
  return mid;
end $$;

create or replace function public.tournament_draft_state(p_tournament_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d tournament_drafts; uid uuid := auth.uid(); adm boolean := coalesce(public.tournament_is_admin(), false);
  cur uuid; myteam uuid; n int; res jsonb;
begin
  if not public.tournament_can_view(p_tournament_id) then raise exception 'Not allowed'; end if;
  select * into d from tournament_drafts where tournament_id = p_tournament_id;
  if not found then return jsonb_build_object('exists', false, 'admin', adm); end if;
  select count(*) into n from tournament_draft_teams(p_tournament_id);
  if d.status = 'picking' and d.team_order is not null and d.pick_index < coalesce(cardinality(d.team_order), 0) then cur := d.team_order[d.pick_index + 1]; end if;
  select team_id into myteam from tournament_draft_teams(p_tournament_id) where captain_user_id = uid limit 1;
  select jsonb_build_object(
    'exists', true, 'admin', adm, 'status', d.status, 'pick_index', d.pick_index, 'teams', n,
    'current_team_id', cur,
    'my_turn', cur is not null and (adm or cur = myteam),
    'my_team_id', myteam,
    'order', (select coalesce(jsonb_agg(jsonb_build_object('team_id', t.team_id, 'name', t.team_name, 'pick_no', o.ord,
        'captain', (select public.tournament_member_name(tm.id) from tournament_team_members tm where tm.team_id = t.team_id and tm.role = 'captain' and tm.status = 'active' limit 1),
        'members', (select coalesce(jsonb_agg(jsonb_build_object('id', tm.id, 'name', public.tournament_member_name(tm.id), 'captain', tm.role = 'captain',
                      'how', coalesce((select pp.how from tournament_draft_pool pp where pp.member_id = tm.id), case when tm.role = 'captain' then 'captain' end)) order by (tm.role = 'captain') desc, tm.joined_at), '[]')
                    from tournament_team_members tm where tm.team_id = t.team_id and tm.status = 'active'))
        order by o.ord), '[]')
      from tournament_draft_teams(p_tournament_id) t
      left join lateral (select x.ord from unnest(coalesce(d.team_order, '{}'::uuid[])) with ordinality as x(tid, ord) where x.tid = t.team_id) o on true),
    'pool', (select coalesce(jsonb_agg(jsonb_build_object('id', pp.id, 'name', coalesce(nullif(pp.external_name, ''), pr.display_name, 'Player'),
        'team_id', pp.team_id, 'how', pp.how, 'pick_no', pp.pick_no) order by (pp.team_id is not null), pp.created_at), '[]')
      from tournament_draft_pool pp left join profiles pr on pr.id = pp.user_id where pp.tournament_id = p_tournament_id),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'team_id', r.team_id, 'team_name', tt.team_name,
        'out_name', public.tournament_member_name(r.out_member_id),
        'in_name', (select coalesce(nullif(pp.external_name, ''), pr.display_name, 'Player') from tournament_draft_pool pp left join profiles pr on pr.id = pp.user_id where pp.id = r.pool_id),
        'reason', r.reason, 'status', r.status, 'created_at', r.created_at) order by r.created_at desc), '[]')
      from tournament_sub_requests r join tournament_teams tt on tt.id = r.team_id
      where r.tournament_id = p_tournament_id and (adm or r.team_id = myteam))
  ) into res;
  return res;
end $$;

create or replace function public.tournament_draft_add_pool(p_tournament_id uuid, p_user_id uuid default null, p_name text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tournament_tournaments; new_id uuid; nm text := nullif(trim(coalesce(p_name, '')), '');
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into t from tournament_tournaments where id = p_tournament_id;
  if not found or t.competition_type <> 'team' then raise exception 'This is not a team tournament'; end if;
  if t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if num_nonnulls(p_user_id, nm) <> 1 then raise exception 'Choose a registered player or type a name, not both'; end if;
  if public.tournament_player_on_live_team(p_tournament_id, p_user_id, null, nm) then raise exception 'That player is already on a team'; end if;
  insert into tournament_drafts(tournament_id, created_by) values (p_tournament_id, auth.uid()) on conflict do nothing;
  begin
    insert into tournament_draft_pool(tournament_id, user_id, external_name, added_by) values (p_tournament_id, p_user_id, nm, auth.uid()) returning tournament_draft_pool.id into new_id;
  exception when unique_violation then raise exception 'That player is already in the pool'; end;
  return new_id;
end $$;

create or replace function public.tournament_draft_remove_pool(p_pool_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare pe tournament_draft_pool;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into pe from tournament_draft_pool where id = p_pool_id for update;
  if not found then raise exception 'Player not found'; end if;
  if pe.team_id is not null then raise exception 'That player is already on a team'; end if;
  if exists(select 1 from tournament_sub_requests where pool_id = p_pool_id and status = 'pending') then raise exception 'That player is part of a pending substitute request'; end if;
  delete from tournament_draft_pool where id = p_pool_id;
end $$;

create or replace function public.tournament_draft_draw_order(p_tournament_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d tournament_drafts; n int; free int; ord uuid[];
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into d from tournament_drafts where tournament_id = p_tournament_id for update;
  if not found then raise exception 'Add players to the pool first'; end if;
  if d.status <> 'setup' then raise exception 'The pick order has already been drawn'; end if;
  if public.tournament_team_size(p_tournament_id) is distinct from 3 then raise exception 'The draft is for 3-player teams. Set the team size to 3.'; end if;
  select count(*) into n from tournament_draft_teams(p_tournament_id);
  if n < 2 then raise exception 'At least two confirmed teams are needed'; end if;
  select count(*) into free from tournament_draft_pool where tournament_id = p_tournament_id and team_id is null;
  if free < n * 2 then raise exception 'The pool needs at least % players (two per team). It has %.', n * 2, free; end if;
  select array_agg(team_id order by random()) into ord from tournament_draft_teams(p_tournament_id);
  update tournament_drafts set team_order = ord, status = 'picking', pick_index = 0, drawn_at = now() where tournament_id = p_tournament_id;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (p_tournament_id, auth.uid(), 'draft_order_drawn', 'draft', p_tournament_id::text);
  return (select jsonb_agg(jsonb_build_object('team_id', t.team_id, 'name', t.team_name) order by o.ord)
          from unnest(ord) with ordinality o(tid, ord) join tournament_draft_teams(p_tournament_id) t on t.team_id = o.tid);
end $$;

create or replace function public.tournament_draft_pick(p_tournament_id uuid, p_pool_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d tournament_drafts; cur uuid; cap uuid; n int;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into d from tournament_drafts where tournament_id = p_tournament_id for update;
  if not found or d.status <> 'picking' then raise exception 'Picking is not open'; end if;
  n := cardinality(d.team_order);
  cur := d.team_order[d.pick_index + 1];
  select captain_user_id into cap from tournament_teams where id = cur;
  if not public.tournament_is_admin() and cap is distinct from auth.uid() then raise exception 'It is not your turn to pick'; end if;
  if not exists(select 1 from tournament_draft_pool where id = p_pool_id and tournament_id = p_tournament_id) then raise exception 'Player not found in the pool'; end if;
  perform public.tournament_draft_assign(p_pool_id, cur, 'captain_pick', d.pick_index + 1);
  update tournament_drafts set pick_index = pick_index + 1, status = case when d.pick_index + 1 >= n then 'lottery' else 'picking' end where tournament_id = p_tournament_id;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (p_tournament_id, auth.uid(), 'draft_pick', 'team', cur::text);
end $$;

create or replace function public.tournament_draft_lottery(p_tournament_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d tournament_drafts; n int; res jsonb := '[]'; r record;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into d from tournament_drafts where tournament_id = p_tournament_id for update;
  if not found or d.status <> 'lottery' then raise exception 'The lottery pick is not ready yet'; end if;
  select count(*) into n from tournament_draft_teams(p_tournament_id);
  if (select count(*) from tournament_draft_pool where tournament_id = p_tournament_id and team_id is null) < n then raise exception 'Not enough players left in the pool'; end if;
  for r in
    select t.team_id, t.team_name, pl.id as pool_id, coalesce(nullif(pl.external_name, ''), pr.display_name, 'Player') as pname
    from (select team_id, team_name, row_number() over (order by random()) rn from tournament_draft_teams(p_tournament_id)) t
    join (select id, user_id, external_name, row_number() over (order by random()) rn from tournament_draft_pool where tournament_id = p_tournament_id and team_id is null) pl on pl.rn = t.rn
    left join profiles pr on pr.id = pl.user_id
    order by t.rn
  loop
    perform public.tournament_draft_assign(r.pool_id, r.team_id, 'lottery', null);
    res := res || jsonb_build_array(jsonb_build_object('team_id', r.team_id, 'team', r.team_name, 'player', r.pname));
  end loop;
  update tournament_drafts set status = 'complete', lottery_at = now() where tournament_id = p_tournament_id;
  insert into tournament_audit_logs(tournament_id, actor_user_id, action, entity_type, entity_id) values (p_tournament_id, auth.uid(), 'draft_lottery', 'draft', p_tournament_id::text);
  return res;
end $$;

create or replace function public.tournament_draft_reset(p_tournament_id uuid, p_cancel boolean default false) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if exists(select 1 from tournament_draft_pool where tournament_id = p_tournament_id and team_id is not null) then raise exception 'Players have already been assigned, so the draft cannot be reset'; end if;
  if p_cancel then
    delete from tournament_draft_pool where tournament_id = p_tournament_id;
    delete from tournament_drafts where tournament_id = p_tournament_id;
  else
    update tournament_drafts set status = 'setup', team_order = null, pick_index = 0, drawn_at = null where tournament_id = p_tournament_id;
  end if;
end $$;

-- substitutions ---------------------------------------------------------------------
create or replace function public.tournament_draft_apply_sub(p_team uuid, p_out uuid, p_pool uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare new_id uuid; ms uuid[];
begin
  new_id := public.tournament_draft_assign(p_pool, p_team, 'substitute', null);
  perform set_config('bpc.draft', '1', true);
  update tournament_team_members set status = 'removed', left_at = now() where id = p_out;
  select array_agg(m.id) into ms from tournament_matches m join tournament_teams tt on tt.id = p_team
    where m.status in ('scheduled','rejected') and (m.participant_a_id = tt.participant_id or m.participant_b_id = tt.participant_id);
  if ms is not null then
    update tournament_lineups set slots = array_replace(slots, p_out, new_id) where match_id = any(ms) and p_out = any(slots);
    update tournament_boards set
      a_member_id = case when a_member_id = p_out then new_id else a_member_id end,
      b_member_id = case when b_member_id = p_out then new_id else b_member_id end,
      score_a = null, score_b = null, status = 'scheduled', submitted_by = null, submitted_at = null, confirmed_by = null, confirmed_at = null
      where match_id = any(ms) and status <> 'approved' and (a_member_id = p_out or b_member_id = p_out);
  end if;
end $$;

create or replace function public.tournament_draft_request_sub(p_team_id uuid, p_out_member uuid, p_pool_id uuid, p_reason text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare tt tournament_teams; d tournament_drafts; mem tournament_team_members; adm boolean := coalesce(public.tournament_is_admin(), false); rid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into tt from tournament_teams where id = p_team_id;
  if not found then raise exception 'Team not found'; end if;
  select * into d from tournament_drafts where tournament_id = tt.tournament_id;
  if not found or d.status <> 'complete' then raise exception 'Substitutes open once the draft is complete'; end if;
  if not adm and tt.captain_user_id is distinct from auth.uid() then raise exception 'Only the captain can request a substitute'; end if;
  select * into mem from tournament_team_members where id = p_out_member and team_id = p_team_id and status = 'active';
  if not found then raise exception 'That player is not on this team'; end if;
  if mem.role = 'captain' then raise exception 'The captain cannot be replaced here. Contact an administrator.'; end if;
  if not exists(select 1 from tournament_draft_pool where id = p_pool_id and tournament_id = tt.tournament_id and team_id is null) then raise exception 'That substitute is not available'; end if;
  if exists(select 1 from tournament_sub_requests where status = 'pending' and (pool_id = p_pool_id or out_member_id = p_out_member)) then raise exception 'A request for this player is already waiting'; end if;
  insert into tournament_sub_requests(tournament_id, team_id, out_member_id, pool_id, reason, requested_by, status, decided_by, decided_at)
    values (tt.tournament_id, p_team_id, p_out_member, p_pool_id, nullif(trim(coalesce(p_reason, '')), ''), auth.uid(), case when adm then 'approved' else 'pending' end, case when adm then auth.uid() end, case when adm then now() end) returning id into rid;
  if adm then
    perform public.tournament_draft_apply_sub(p_team_id, p_out_member, p_pool_id);
    return 'applied';
  end if;
  return 'requested';
end $$;

create or replace function public.tournament_draft_decide_sub(p_request_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r tournament_sub_requests;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into r from tournament_sub_requests where id = p_request_id for update;
  if not found or r.status <> 'pending' then raise exception 'This request is no longer pending'; end if;
  if p_approve then
    if not exists(select 1 from tournament_team_members where id = r.out_member_id and status = 'active') then raise exception 'That player has already left the team'; end if;
    perform public.tournament_draft_apply_sub(r.team_id, r.out_member_id, r.pool_id);
  end if;
  update tournament_sub_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now() where id = r.id;
end $$;

revoke all on function public.tournament_draft_teams(uuid), public.tournament_block_manual_roster(), public.tournament_draft_assign(uuid, uuid, text, int), public.tournament_draft_apply_sub(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.tournament_draft_state(uuid) from public;
grant execute on function public.tournament_draft_state(uuid) to anon, authenticated;
revoke all on function public.tournament_draft_add_pool(uuid, uuid, text), public.tournament_draft_remove_pool(uuid), public.tournament_draft_draw_order(uuid), public.tournament_draft_pick(uuid, uuid),
  public.tournament_draft_lottery(uuid), public.tournament_draft_reset(uuid, boolean), public.tournament_draft_request_sub(uuid, uuid, uuid, text), public.tournament_draft_decide_sub(uuid, boolean) from public, anon;
grant execute on function public.tournament_draft_add_pool(uuid, uuid, text), public.tournament_draft_remove_pool(uuid), public.tournament_draft_draw_order(uuid), public.tournament_draft_pick(uuid, uuid),
  public.tournament_draft_lottery(uuid), public.tournament_draft_reset(uuid, boolean), public.tournament_draft_request_sub(uuid, uuid, uuid, text), public.tournament_draft_decide_sub(uuid, boolean) to authenticated;
