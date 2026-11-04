-- BPC Houses: club members split into named houses that compete for a monthly House Cup.
-- House points come from members' normal counted leaderboard points. Nothing here changes
-- the leaderboard, ranking or any counting rule.

create table if not exists public.houses(
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 24),
  color text not null default '#2459e8' check (color ~ '^#[0-9a-fA-F]{6}$'),
  motto text not null default '' check (char_length(motto) <= 60),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists houses_name_ci on public.houses (lower(btrim(name)));

create table if not exists public.house_members(
  player_id uuid primary key references public.players(id) on delete cascade,
  house_id uuid not null references public.houses(id) on delete cascade,
  assigned_at timestamptz not null default now()
);
create index if not exists house_members_house on public.house_members(house_id);

create table if not exists public.house_settings(
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  best_n int not null default 0 check (best_n between 0 and 30),   -- 0 = every member counts
  started_month date not null default date_trunc('month', (now() at time zone 'Asia/Dhaka'))::date,
  drawn_at timestamptz
);
insert into public.house_settings(id) values (1) on conflict do nothing;

alter table public.houses enable row level security;
alter table public.house_members enable row level security;
alter table public.house_settings enable row level security;
revoke all on public.houses, public.house_members, public.house_settings from anon, authenticated;

-- points per house for one month (internal)
create or replace function public.house_month_points(p_month date)
returns table(house_id uuid, pts bigint, members int, counted int, played int)
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (select best_n from house_settings where id = 1),
  lb as (select player_id, points::bigint pts, matches_played::int mp
         from get_leaderboard(date_trunc('month', p_month)::date)),
  m as (select hm.house_id, hm.player_id, coalesce(lb.pts, 0) pts, coalesce(lb.mp, 0) mp,
               row_number() over (partition by hm.house_id order by coalesce(lb.pts, 0) desc, hm.player_id) rn
        from house_members hm
        join players p on p.id = hm.player_id and p.active
        left join lb on lb.player_id = hm.player_id)
  select h.id,
         coalesce(sum(m.pts) filter (where (select best_n from s) = 0 or m.rn <= (select best_n from s)), 0)::bigint,
         count(m.player_id)::int,
         (case when (select best_n from s) = 0 then count(m.player_id)
               else least(count(m.player_id), (select best_n from s)) end)::int,
         (count(*) filter (where m.mp > 0))::int
  from houses h left join m on m.house_id = h.id
  group by h.id
$$;
revoke all on function public.house_month_points(date) from public, anon, authenticated;

create or replace function public.get_house_bundle(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cur date := date_trunc('month', (now() at time zone 'Asia/Dhaka')::date)::date;
  v_month date;
  s house_settings;
  won jsonb := '{}'::jsonb;
  mth date; w record; houses_j jsonb; derby_j jsonb; unassigned int;
begin
  select * into s from house_settings where id = 1;
  if not s.enabled and not coalesce(public.is_admin(), false) then
    return jsonb_build_object('enabled', false);
  end if;
  v_month := date_trunc('month', coalesce(p_month, v_cur))::date;

  -- months won so far (completed months from the start month)
  for mth in select generate_series(s.started_month, (v_cur - interval '1 month')::date, interval '1 month')::date loop
    select * into w from (
      select house_id, pts, lead(pts) over (order by pts desc) as nxt, row_number() over (order by pts desc) rn
      from house_month_points(mth)) q where rn = 1;
    if found and w.pts > 0 and (w.nxt is null or w.pts > w.nxt) then
      won := jsonb_set(won, array[w.house_id::text], to_jsonb(coalesce((won ->> w.house_id::text)::int, 0) + 1));
    end if;
  end loop;

  with lb as (select player_id, points::bigint points, matches_played::int matches_played, rank
              from get_leaderboard(v_month)),
  hp as (select * from house_month_points(v_month))
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'name', h.name, 'color', h.color, 'motto', h.motto,
      'points', hp.pts, 'members', hp.members, 'counted', hp.counted, 'played', hp.played,
      'avg', case when hp.counted > 0 then round(hp.pts::numeric / hp.counted, 1) else 0 end,
      'months_won', coalesce((won ->> h.id::text)::int, 0),
      'roster', (select coalesce(jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.display_name,
                   'points', coalesce(lb.points, 0), 'matches', coalesce(lb.matches_played, 0), 'rank', lb.rank)
                   order by coalesce(lb.points, 0) desc, p.display_name), '[]'::jsonb)
                 from house_members hm join players p on p.id = hm.player_id and p.active
                 left join lb on lb.player_id = p.id where hm.house_id = h.id)
    ) order by hp.pts desc, h.sort_order, h.name), '[]'::jsonb)
  into houses_j
  from houses h join hp on hp.house_id = h.id;

  -- house v house results: matches between members of different houses, each game counted once
  with pn as (select id, lower(regexp_replace(btrim(display_name), '\s+', ' ', 'g')) k from players where active),
  g as (
    select distinct
      least(m.player_id, op.id) lo, greatest(m.player_id, op.id) hi, m.match_date,
      case when m.player_id < op.id then m.player_goals else m.opponent_goals end glo,
      case when m.player_id < op.id then m.opponent_goals else m.player_goals end ghi
    from matches m
    join pn op on op.k = m.opponent_key and op.id <> m.player_id
    where m.status = 'approved' and m.counted
      and m.match_date >= v_month and m.match_date < (v_month + interval '1 month')::date
  ),
  gh as (
    select g.*, a.house_id ha, b.house_id hb
    from g join house_members a on a.player_id = g.lo join house_members b on b.player_id = g.hi
    where a.house_id <> b.house_id
  ),
  o as (
    select least(ha, hb) x, greatest(ha, hb) y,
      case when ha < hb then glo else ghi end gx, case when ha < hb then ghi else glo end gy
    from gh
  ),
  agg as (
    select x, y, count(*) played, count(*) filter (where gx > gy) xw, count(*) filter (where gy > gx) yw,
           count(*) filter (where gx = gy) dr, sum(gx) xg, sum(gy) yg
    from o group by x, y
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'a', jsonb_build_object('id', hx.id, 'name', hx.name, 'color', hx.color),
      'b', jsonb_build_object('id', hy.id, 'name', hy.name, 'color', hy.color),
      'played', agg.played, 'a_wins', agg.xw, 'b_wins', agg.yw, 'draws', agg.dr,
      'a_goals', agg.xg, 'b_goals', agg.yg) order by agg.played desc), '[]'::jsonb)
  into derby_j
  from agg join houses hx on hx.id = agg.x join houses hy on hy.id = agg.y;

  select count(*)::int into unassigned from players p
  where p.active and not exists (select 1 from house_members hm where hm.player_id = p.id)
    and exists (select 1 from matches m where m.player_id = p.id and m.status = 'approved' and m.counted);

  return jsonb_build_object('enabled', s.enabled, 'best_n', s.best_n, 'started_month', s.started_month,
    'drawn_at', s.drawn_at, 'month', v_month, 'houses', houses_j, 'derby', derby_j, 'unassigned', unassigned);
end $$;
revoke all on function public.get_house_bundle(date) from public;
grant execute on function public.get_house_bundle(date) to anon, authenticated;

-- new players who have played a counted match join the smallest house on their own
create or replace function public.house_sync()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; tgt uuid; n int := 0;
begin
  if not exists (select 1 from house_settings where id = 1 and enabled) then return 0; end if;
  if (select count(*) from houses) < 2 then return 0; end if;
  for r in select p.id from players p
           where p.active and not exists (select 1 from house_members hm where hm.player_id = p.id)
             and exists (select 1 from matches m where m.player_id = p.id and m.status = 'approved' and m.counted)
           order by random() loop
    select h.id into tgt from houses h
      left join house_members hm on hm.house_id = h.id
      group by h.id order by count(hm.player_id), random() limit 1;
    insert into house_members(player_id, house_id) values (r.id, tgt) on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.house_sync() from public;
grant execute on function public.house_sync() to anon, authenticated;

-- admin: create or edit a house (p_id null = create)
create or replace function public.house_admin_save(p_id uuid, p_name text, p_color text, p_motto text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Only admins can manage houses.'; end if;
  p_name := btrim(coalesce(p_name, '')); p_motto := btrim(coalesce(p_motto, ''));
  if char_length(p_name) < 2 or char_length(p_name) > 24 then raise exception 'House name must be 2 to 24 characters.'; end if;
  if p_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Pick a colour.'; end if;
  if char_length(p_motto) > 60 then raise exception 'Motto can be at most 60 characters.'; end if;
  begin
    if p_id is null then
      if (select count(*) from houses) >= 6 then raise exception 'You can have at most 6 houses.'; end if;
      insert into houses(name, color, motto, sort_order)
        values (p_name, p_color, p_motto, coalesce((select max(sort_order) + 1 from houses), 0)) returning id into v;
    else
      update houses set name = p_name, color = p_color, motto = p_motto where id = p_id returning id into v;
      if v is null then raise exception 'House not found.'; end if;
    end if;
  exception when unique_violation then
    raise exception 'Another house already uses that name.';
  end;
  return v;
end $$;

create or replace function public.house_admin_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Only admins can manage houses.'; end if;
  delete from houses where id = p_id;
end $$;

create or replace function public.house_admin_settings(p_enabled boolean, p_best_n int, p_started_month date)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Only admins can manage houses.'; end if;
  if p_enabled and (select count(*) from houses) < 2 then raise exception 'Create at least 2 houses before turning the House Cup on.'; end if;
  update house_settings set enabled = p_enabled, best_n = greatest(0, least(30, coalesce(p_best_n, 0))),
    started_month = date_trunc('month', coalesce(p_started_month, started_month))::date where id = 1;
end $$;

create or replace function public.house_admin_move(p_player uuid, p_house uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Only admins can manage houses.'; end if;
  if p_house is null then delete from house_members where player_id = p_player;
  else
    if not exists (select 1 from houses where id = p_house) then raise exception 'House not found.'; end if;
    insert into house_members(player_id, house_id) values (p_player, p_house)
      on conflict (player_id) do update set house_id = excluded.house_id, assigned_at = now();
  end if;
end $$;

-- balanced draw: players with a counted match are ranked by last month's points (random among ties)
-- and dealt to the houses in a snake order, so every house gets a similar mix
create or replace function public.house_admin_draw()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  hs uuid[]; hn text[]; n int; r record; k int; idx int; out jsonb := '[]'::jsonb;
  prev date := (date_trunc('month', (now() at time zone 'Asia/Dhaka')::date) - interval '1 month')::date;
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Only admins can manage houses.'; end if;
  select array_agg(id order by sort_order, name), array_agg(name order by sort_order, name) into hs, hn from houses;
  n := coalesce(cardinality(hs), 0);
  if n < 2 then raise exception 'Create at least 2 houses first.'; end if;
  delete from house_members;
  for r in
    select p.id pid, p.display_name nm, row_number() over (order by coalesce(lb.points, 0) desc, random()) rn
    from players p
    left join get_leaderboard(prev) lb on lb.player_id = p.id
    where p.active and exists (select 1 from matches m where m.player_id = p.id and m.status = 'approved' and m.counted)
  loop
    k := r.rn - 1;
    idx := case when (k / n) % 2 = 0 then k % n else n - 1 - (k % n) end;
    insert into house_members(player_id, house_id) values (r.pid, hs[idx + 1]);
    out := out || jsonb_build_object('pick', r.rn, 'player_id', r.pid, 'name', r.nm, 'house_id', hs[idx + 1], 'house_name', hn[idx + 1]);
  end loop;
  update house_settings set drawn_at = now() where id = 1;
  return out;
end $$;

revoke all on function public.house_admin_save(uuid, text, text, text), public.house_admin_delete(uuid),
  public.house_admin_settings(boolean, int, date), public.house_admin_move(uuid, uuid), public.house_admin_draw() from public;
grant execute on function public.house_admin_save(uuid, text, text, text), public.house_admin_delete(uuid),
  public.house_admin_settings(boolean, int, date), public.house_admin_move(uuid, uuid), public.house_admin_draw() to authenticated;
