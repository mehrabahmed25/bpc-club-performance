-- BPC Team Series (e.g. "Married v Unmarried"): two fixed teams, 1v1 games per round,
-- the team with more game wins takes the round, the best of N rounds takes the series.
-- Fully separate from friendly-match stats, the leaderboard and tournaments.
create table if not exists public.team_series(
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 100),
  team_a text not null check (length(trim(team_a)) between 1 and 40),
  team_b text not null check (length(trim(team_b)) between 1 and 40),
  per_side integer not null default 8 check (per_side between 1 and 30),
  rounds integer not null default 3 check (rounds between 1 and 9),
  status text not null default 'open' check (status in ('open','live','finished','archived')),
  reg_open boolean not null default true,
  reg_deadline timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create table if not exists public.team_series_members(
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.team_series(id),
  player_id uuid not null references public.players(id),
  user_id uuid not null,
  side text not null check (side in ('a','b')),
  status text not null default 'pending' check (status in ('pending','confirmed','removed')),
  created_at timestamptz not null default now()
);
create unique index if not exists team_series_member_once on public.team_series_members(series_id,user_id) where status<>'removed';
create table if not exists public.team_series_games(
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.team_series(id),
  round_no integer not null check (round_no>=1),
  a_member uuid not null references public.team_series_members(id),
  b_member uuid not null references public.team_series_members(id),
  a_goals integer check (a_goals between 0 and 99),
  b_goals integer check (b_goals between 0 and 99),
  status text not null default 'scheduled' check (status in ('scheduled','submitted','approved','cancelled')),
  submitted_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists team_series_game_a on public.team_series_games(series_id,round_no,a_member) where status<>'cancelled';
create unique index if not exists team_series_game_b on public.team_series_games(series_id,round_no,b_member) where status<>'cancelled';
alter table public.team_series enable row level security;
alter table public.team_series_members enable row level security;
alter table public.team_series_games enable row level security;
revoke all on public.team_series, public.team_series_members, public.team_series_games from anon, authenticated;

create or replace function public.series_rounds(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(r order by (r->>'round')::int),'[]'::jsonb) from (
    select jsonb_build_object('round',g.round_no,
      'a_wins',count(*) filter (where g.status='approved' and g.a_goals>g.b_goals),
      'b_wins',count(*) filter (where g.status='approved' and g.a_goals<g.b_goals),
      'a_goals',coalesce(sum(g.a_goals) filter (where g.status='approved'),0),
      'b_goals',coalesce(sum(g.b_goals) filter (where g.status='approved'),0),
      'approved',count(*) filter (where g.status='approved'),'total',count(*),
      'complete',count(*)=count(*) filter (where g.status='approved'),
      'winner',case when count(*)<>count(*) filter (where g.status='approved') then null
        when count(*) filter (where g.a_goals>g.b_goals)>count(*) filter (where g.a_goals<g.b_goals) then 'a'
        when count(*) filter (where g.a_goals<g.b_goals)>count(*) filter (where g.a_goals>g.b_goals) then 'b'
        when sum(g.a_goals)>sum(g.b_goals) then 'a' when sum(g.a_goals)<sum(g.b_goals) then 'b' else 'draw' end) r
    from public.team_series_games g where g.series_id=p_id and g.status<>'cancelled' group by g.round_no) x;
$$;

create or replace function public.series_create(p_name text,p_team_a text,p_team_b text,p_per_side integer,p_rounds integer,p_deadline timestamptz)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v uuid;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  if lower(trim(p_team_a))=lower(trim(p_team_b)) then raise exception 'The two teams need different names.'; end if;
  insert into public.team_series(name,team_a,team_b,per_side,rounds,reg_deadline)
  values (trim(p_name),trim(p_team_a),trim(p_team_b),coalesce(p_per_side,8),coalesce(p_rounds,3),p_deadline) returning id into v;
  return v;
end $$;

create or replace function public.series_set(p_id uuid,p_status text default null,p_reg_open boolean default null,p_deadline timestamptz default null,p_clear_deadline boolean default false)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  if p_status is not null and p_status not in ('open','live','finished','archived') then raise exception 'Unknown status.'; end if;
  update public.team_series set status=coalesce(p_status,status), reg_open=coalesce(p_reg_open,reg_open),
    reg_deadline=case when p_clear_deadline then null else coalesce(p_deadline,reg_deadline) end where id=p_id;
  if not found then raise exception 'Series not found.'; end if;
end $$;

create or replace function public.series_register(p_id uuid,p_side text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.team_series; v_player uuid; v_n integer;
begin
  if auth.uid() is null then raise exception 'Sign in to join.'; end if;
  if p_side not in ('a','b') then raise exception 'Choose a team.'; end if;
  select * into s from public.team_series where id=p_id;
  if not found or s.status<>'open' or not s.reg_open then raise exception 'Sign-ups are closed.'; end if;
  if s.reg_deadline is not null and s.reg_deadline<now() then raise exception 'The sign-up deadline has passed.'; end if;
  select id into v_player from public.players where user_id=auth.uid() and active;
  if v_player is null then raise exception 'Your account is not linked to an active player.'; end if;
  if exists(select 1 from public.team_series_members where series_id=p_id and user_id=auth.uid() and status<>'removed') then raise exception 'You have already joined this series.'; end if;
  select count(*) into v_n from public.team_series_members where series_id=p_id and side=p_side and status='confirmed';
  if v_n>=s.per_side then raise exception 'That team is full.'; end if;
  insert into public.team_series_members(series_id,player_id,user_id,side) values (p_id,v_player,auth.uid(),p_side);
end $$;

create or replace function public.series_leave(p_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.team_series_members;
begin
  select * into m from public.team_series_members where series_id=p_id and user_id=auth.uid() and status<>'removed';
  if not found then raise exception 'You are not in this series.'; end if;
  if exists(select 1 from public.team_series_games g where g.status<>'cancelled' and (g.a_member=m.id or g.b_member=m.id)) then raise exception 'You already have a game scheduled. Ask an admin to change it.'; end if;
  update public.team_series_members set status='removed' where id=m.id;
end $$;

create or replace function public.series_member_action(p_member uuid,p_action text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.team_series_members; s public.team_series; v_n integer;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into m from public.team_series_members where id=p_member;
  if not found then raise exception 'Entry not found.'; end if;
  select * into s from public.team_series where id=m.series_id;
  if p_action='approve' then
    if m.status<>'pending' then raise exception 'Only waiting entries can be approved.'; end if;
    select count(*) into v_n from public.team_series_members where series_id=m.series_id and side=m.side and status='confirmed';
    if v_n>=s.per_side then raise exception 'That team already has % players.', s.per_side; end if;
    update public.team_series_members set status='confirmed' where id=m.id;
  elsif p_action in ('remove','switch') then
    if exists(select 1 from public.team_series_games g where g.status<>'cancelled' and (g.a_member=m.id or g.b_member=m.id)) then raise exception 'This player has a game scheduled. Cancel or replace the pairing first.'; end if;
    if p_action='remove' then update public.team_series_members set status='removed' where id=m.id;
    else
      if m.status='confirmed' then
        select count(*) into v_n from public.team_series_members where series_id=m.series_id and side=(case m.side when 'a' then 'b' else 'a' end) and status='confirmed';
        if v_n>=s.per_side then raise exception 'The other team is full.'; end if;
      end if;
      update public.team_series_members set side=(case m.side when 'a' then 'b' else 'a' end) where id=m.id;
    end if;
  else raise exception 'Unknown action.'; end if;
end $$;

-- p_pairs: [{"a":"<member id>","b":"<member id>"}, ...] for one round. Replaces still-unplayed games in that round.
create or replace function public.series_pair_round(p_id uuid,p_round integer,p_pairs jsonb) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.team_series; x jsonb; n integer:=0;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into s from public.team_series where id=p_id;
  if not found then raise exception 'Series not found.'; end if;
  if p_round<1 or p_round>s.rounds then raise exception 'Round must be between 1 and %.', s.rounds; end if;
  if exists(select 1 from public.team_series_games where series_id=p_id and round_no=p_round and status in ('submitted','approved')) then raise exception 'This round already has scores. Pairings are locked.'; end if;
  update public.team_series_games set status='cancelled' where series_id=p_id and round_no=p_round and status='scheduled';
  for x in select * from jsonb_array_elements(coalesce(p_pairs,'[]'::jsonb)) loop
    if not exists(select 1 from public.team_series_members where id=(x->>'a')::uuid and series_id=p_id and side='a' and status='confirmed')
      or not exists(select 1 from public.team_series_members where id=(x->>'b')::uuid and series_id=p_id and side='b' and status='confirmed') then
      raise exception 'Each pairing needs one confirmed player from each team.'; end if;
    insert into public.team_series_games(series_id,round_no,a_member,b_member) values (p_id,p_round,(x->>'a')::uuid,(x->>'b')::uuid);
    n:=n+1;
  end loop;
  return n;
end $$;

create or replace function public.series_submit_score(p_game uuid,p_a integer,p_b integer) returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.team_series_games; v_adm boolean; v_part boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_a is null or p_b is null or p_a<0 or p_b<0 or p_a>99 or p_b>99 then raise exception 'Enter both scores.'; end if;
  select * into g from public.team_series_games where id=p_game;
  if not found or g.status='cancelled' then raise exception 'Game not found.'; end if;
  v_adm:=public.tournament_is_admin();
  v_part:=exists(select 1 from public.team_series_members m where m.id in (g.a_member,g.b_member) and m.user_id=auth.uid());
  if not v_adm and not v_part then raise exception 'Only the two players or an admin can send this score.'; end if;
  if g.status='approved' and not v_adm then raise exception 'This score is already approved.'; end if;
  update public.team_series_games set a_goals=p_a,b_goals=p_b,submitted_by=auth.uid(),status=case when v_adm then 'approved' else 'submitted' end where id=p_game;
  return case when v_adm then 'approved' else 'submitted' end;
end $$;

create or replace function public.series_review_score(p_game uuid,p_approve boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  if p_approve then update public.team_series_games set status='approved' where id=p_game and status='submitted';
  else update public.team_series_games set status='scheduled',a_goals=null,b_goals=null where id=p_game and status in ('submitted','approved'); end if;
  if not found then raise exception 'Nothing to review for this game.'; end if;
end $$;

create or replace function public.get_series_list() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_adm boolean:=coalesce(auth.uid() is not null and public.tournament_is_admin(),false);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'team_a',s.team_a,'team_b',s.team_b,'status',s.status,'reg_open',s.reg_open,'reg_deadline',s.reg_deadline,'per_side',s.per_side,'rounds',s.rounds,
    'a_count',(select count(*) from public.team_series_members m where m.series_id=s.id and m.side='a' and m.status='confirmed'),
    'b_count',(select count(*) from public.team_series_members m where m.series_id=s.id and m.side='b' and m.status='confirmed'),
    'pending',case when v_adm then (select count(*) from public.team_series_members m where m.series_id=s.id and m.status='pending') else 0 end,
    'rounds_won',(select jsonb_build_object('a',count(*) filter (where r->>'winner'='a'),'b',count(*) filter (where r->>'winner'='b')) from jsonb_array_elements(public.series_rounds(s.id)) r))
    order by s.created_at desc) from public.team_series s where s.status<>'archived' or v_adm),'[]'::jsonb);
end $$;

create or replace function public.get_series_bundle(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_adm boolean:=coalesce(auth.uid() is not null and public.tournament_is_admin(),false); s public.team_series; v_me public.team_series_members;
begin
  select * into s from public.team_series where id=p_id;
  if not found or (s.status='archived' and not v_adm) then return null; end if;
  select * into v_me from public.team_series_members where series_id=p_id and user_id=auth.uid() and status<>'removed';
  return jsonb_build_object('series',to_jsonb(s)-'created_by','is_admin',v_adm,
    'me',case when v_me.id is null then null else jsonb_build_object('member_id',v_me.id,'side',v_me.side,'status',v_me.status) end,
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'player_id',m.player_id,'name',p.display_name,'side',m.side,'status',m.status) order by m.created_at)
       from public.team_series_members m join public.players p on p.id=m.player_id
       where m.series_id=p_id and m.status<>'removed' and (m.status='confirmed' or v_adm or m.user_id=auth.uid())),'[]'::jsonb),
    'games',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'round',g.round_no,'a_member',g.a_member,'b_member',g.b_member,'status',g.status,
        'a_goals',case when g.status='approved' or v_adm or exists(select 1 from public.team_series_members mm where mm.id in (g.a_member,g.b_member) and mm.user_id=auth.uid()) then g.a_goals end,
        'b_goals',case when g.status='approved' or v_adm or exists(select 1 from public.team_series_members mm where mm.id in (g.a_member,g.b_member) and mm.user_id=auth.uid()) then g.b_goals end,
        'mine',exists(select 1 from public.team_series_members mm where mm.id in (g.a_member,g.b_member) and mm.user_id=auth.uid())) order by g.round_no,g.created_at)
       from public.team_series_games g where g.series_id=p_id and g.status<>'cancelled'),'[]'::jsonb),
    'rounds',public.series_rounds(p_id));
end $$;

do $$ declare f text; begin
  foreach f in array array['series_rounds(uuid)','get_series_list()','get_series_bundle(uuid)'] loop
    execute format('revoke execute on function public.%s from public',f); execute format('grant execute on function public.%s to anon, authenticated',f); end loop;
  foreach f in array array['series_create(text,text,text,integer,integer,timestamptz)','series_set(uuid,text,boolean,timestamptz,boolean)','series_register(uuid,text)','series_leave(uuid)','series_member_action(uuid,text)','series_pair_round(uuid,integer,jsonb)','series_submit_score(uuid,integer,integer)','series_review_score(uuid,boolean)'] loop
    execute format('revoke execute on function public.%s from public',f); execute format('grant execute on function public.%s to authenticated',f); end loop;
end $$;
