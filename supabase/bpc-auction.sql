-- BPC Bid Cup: live player auction for registered members.
-- Fully separate from the leaderboard and its counting rules.

create table if not exists public.auctions(
  id uuid primary key default gen_random_uuid(),
  name text not null check(char_length(trim(name)) between 2 and 100),
  status text not null default 'open' check(status in ('open','live','finished','archived')),
  reg_open boolean not null default true,
  manager_slots int not null default 6 check(manager_slots between 2 and 32),
  purse int not null default 100 check(purse>0),
  bid_step int not null default 1 check(bid_step>0),
  min_squad int not null default 6 check(min_squad>=1),
  max_squad int not null default 8,
  timer_secs int not null default 15 check(timer_secs between 5 and 120),
  retentions int not null default 0 check(retentions between 0 and 5),
  base_a int not null default 10 check(base_a>=1),
  base_b int not null default 6 check(base_b>=1),
  base_c int not null default 3 check(base_c>=1),
  lot_status text not null default 'idle' check(lot_status in ('idle','open','paused')),
  cur_member uuid, cur_bid int, cur_leader uuid, cur_ends timestamptz, paused_left int,
  last_member uuid, last_leader uuid, last_price int, last_seq int not null default 0,
  created_by uuid default auth.uid(), created_at timestamptz not null default now(),
  check(max_squad>=min_squad)
);
create table if not exists public.auction_members(
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references public.auctions(id) on delete cascade,
  player_id uuid not null references public.players(id),
  user_id uuid not null,
  role text not null check(role in ('manager','player')),
  status text not null default 'pending' check(status in ('pending','approved','removed')),
  tier text not null default 'C' check(tier in ('A','B','C')),
  purse int not null default 0,
  lot_state text not null default 'waiting' check(lot_state in ('waiting','current','sold','unsold','retained')),
  lot_order int,
  created_at timestamptz not null default now(),
  unique(auction_id,player_id)
);
create table if not exists public.auction_picks(
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references public.auctions(id) on delete cascade,
  manager_id uuid not null references public.auction_members(id) on delete cascade,
  member_id uuid not null references public.auction_members(id) on delete cascade,
  price int not null check(price>=0),
  retained boolean not null default false,
  created_at timestamptz not null default now(),
  unique(auction_id,member_id)
);
create table if not exists public.auction_bids(
  id bigint generated always as identity primary key,
  auction_id uuid not null references public.auctions(id) on delete cascade,
  member_id uuid not null,
  manager_id uuid not null,
  amount int not null,
  created_at timestamptz not null default now()
);
create index if not exists auction_bids_lot on public.auction_bids(auction_id,member_id,id desc);
alter table public.auctions enable row level security;
alter table public.auction_members enable row level security;
alter table public.auction_picks enable row level security;
alter table public.auction_bids enable row level security;
revoke all on public.auctions,public.auction_members,public.auction_picks,public.auction_bids from anon,authenticated;

create or replace function public.auction_base(a public.auctions, t text) returns int
language sql immutable set search_path=public,pg_temp
as $$ select case t when 'A' then a.base_a when 'B' then a.base_b else a.base_c end $$;

create or replace function public.auction_reset_purses(p_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.auction_members m set purse=(select a.purse from public.auctions a where a.id=p_id)
    - coalesce((select sum(k.price) from public.auction_picks k where k.manager_id=m.id),0)
  where m.auction_id=p_id and m.role='manager' and m.status='approved';
end $$;

create or replace function public.auction_max_bid(p_id uuid, p_mgr uuid) returns int
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.auctions; m public.auction_members; n int; need int;
begin
  select * into a from public.auctions where id=p_id;
  select * into m from public.auction_members where id=p_mgr and auction_id=p_id;
  if a.id is null or m.id is null then return 0; end if;
  select count(*) into n from public.auction_picks where manager_id=p_mgr;
  if n>=a.max_squad then return 0; end if;
  need:=greatest(0,a.min_squad-n-1);
  return greatest(0,m.purse-need*least(a.base_a,a.base_b,a.base_c));
end $$;

create or replace function public.auction_create(p_name text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v uuid;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  insert into public.auctions(name) values (trim(p_name)) returning id into v;
  return v;
end $$;

create or replace function public.auction_set(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; k text; cfg text[]:=array['manager_slots','purse','bid_step','min_squad','max_squad','timer_secs','retentions','base_a','base_b','base_c'];
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into a from public.auctions where id=p_id for update;
  if not found then raise exception 'Auction not found.'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k=any(cfg) and a.status<>'open' then raise exception 'Rules can only change before the auction starts.'; end if;
    if k not in ('name','reg_open','status') and not k=any(cfg) then raise exception 'Unknown setting %.',k; end if;
  end loop;
  if p_patch ? 'status' and p_patch->>'status' not in ('finished','archived') then raise exception 'Use Start for going live.'; end if;
  if (p_patch->>'status')='finished' and a.lot_status<>'idle' then raise exception 'Close the current player first.'; end if;
  update public.auctions set
    name=coalesce(trim(p_patch->>'name'),name),
    reg_open=coalesce((p_patch->>'reg_open')::boolean,reg_open),
    status=coalesce(p_patch->>'status',status),
    manager_slots=coalesce((p_patch->>'manager_slots')::int,manager_slots),
    purse=coalesce((p_patch->>'purse')::int,purse),
    bid_step=coalesce((p_patch->>'bid_step')::int,bid_step),
    min_squad=coalesce((p_patch->>'min_squad')::int,min_squad),
    max_squad=coalesce((p_patch->>'max_squad')::int,max_squad),
    timer_secs=coalesce((p_patch->>'timer_secs')::int,timer_secs),
    retentions=coalesce((p_patch->>'retentions')::int,retentions),
    base_a=coalesce((p_patch->>'base_a')::int,base_a),
    base_b=coalesce((p_patch->>'base_b')::int,base_b),
    base_c=coalesce((p_patch->>'base_c')::int,base_c)
  where id=p_id;
  perform public.auction_reset_purses(p_id);
end $$;

create or replace function public.auction_register(p_id uuid, p_role text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; v_player uuid; ex public.auction_members;
begin
  if auth.uid() is null then raise exception 'Sign in to join.'; end if;
  if p_role not in ('manager','player') then raise exception 'Choose manager or player.'; end if;
  select * into a from public.auctions where id=p_id;
  if not found or a.status<>'open' or not a.reg_open then raise exception 'Sign-ups are closed.'; end if;
  select id into v_player from public.players where user_id=auth.uid() and active;
  if v_player is null then raise exception 'Your account is not linked to an active player.'; end if;
  select * into ex from public.auction_members where auction_id=p_id and player_id=v_player;
  if found and ex.status<>'removed' then raise exception 'You have already joined this auction.'; end if;
  if found then
    update public.auction_members set role=p_role,status=case when p_role='player' then 'approved' else 'pending' end,lot_state='waiting',tier='C' where id=ex.id;
  else
    insert into public.auction_members(auction_id,player_id,user_id,role,status)
    values (p_id,v_player,auth.uid(),p_role,case when p_role='player' then 'approved' else 'pending' end);
  end if;
end $$;

create or replace function public.auction_leave(p_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; m public.auction_members;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select * into a from public.auctions where id=p_id;
  if not found or a.status<>'open' then raise exception 'You can only leave before the auction starts.'; end if;
  select * into m from public.auction_members where auction_id=p_id and user_id=auth.uid() and status<>'removed';
  if not found then raise exception 'You have not joined this auction.'; end if;
  delete from public.auction_picks where manager_id=m.id or member_id=m.id;
  update public.auction_members set status='removed',lot_state='waiting' where id=m.id;
  perform public.auction_reset_purses(p_id);
end $$;

create or replace function public.auction_member_action(p_member uuid, p_action text, p_tier text default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.auction_members; a public.auctions; n int;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into m from public.auction_members where id=p_member;
  if not found then raise exception 'Member not found.'; end if;
  select * into a from public.auctions where id=m.auction_id for update;
  if a.status<>'open' then raise exception 'Changes are locked once the auction starts.'; end if;
  if p_action='approve' then
    if m.role<>'manager' then raise exception 'Only managers need approval.'; end if;
    select count(*) into n from public.auction_members where auction_id=a.id and role='manager' and status='approved';
    if n>=a.manager_slots then raise exception 'All % manager slots are taken.',a.manager_slots; end if;
    update public.auction_members set status='approved' where id=m.id;
  elsif p_action='remove' then
    delete from public.auction_picks where manager_id=m.id or member_id=m.id;
    update public.auction_members set status='removed',lot_state='waiting' where id=m.id;
  elsif p_action='to_player' then
    delete from public.auction_picks where manager_id=m.id;
    update public.auction_members set role='player',status='approved',lot_state='waiting' where id=m.id;
  elsif p_action='to_manager' then
    delete from public.auction_picks where member_id=m.id;
    update public.auction_members set role='manager',status='pending',lot_state='waiting' where id=m.id;
  elsif p_action='tier' then
    if p_tier not in ('A','B','C') then raise exception 'Tier must be A, B or C.'; end if;
    if exists(select 1 from public.auction_picks where member_id=m.id) then raise exception 'Remove the retention first.'; end if;
    update public.auction_members set tier=p_tier where id=m.id;
  else raise exception 'Unknown action.'; end if;
  perform public.auction_reset_purses(a.id);
end $$;

create or replace function public.auction_retain(p_manager uuid, p_player uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare mg public.auction_members; pl public.auction_members; a public.auctions; n int;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into mg from public.auction_members where id=p_manager and role='manager' and status='approved';
  select * into pl from public.auction_members where id=p_player and role='player' and status='approved';
  if mg.id is null or pl.id is null or mg.auction_id<>pl.auction_id then raise exception 'Pick an approved manager and an approved player.'; end if;
  select * into a from public.auctions where id=mg.auction_id for update;
  if a.status<>'open' then raise exception 'Retentions are locked once the auction starts.'; end if;
  if exists(select 1 from public.auction_picks where member_id=pl.id) then raise exception 'That player is already retained.'; end if;
  select count(*) into n from public.auction_picks where manager_id=mg.id and retained;
  if n>=a.retentions then raise exception 'This manager has used all % retention(s).',a.retentions; end if;
  insert into public.auction_picks(auction_id,manager_id,member_id,price,retained) values (a.id,mg.id,pl.id,public.auction_base(a,pl.tier),true);
  update public.auction_members set lot_state='retained' where id=pl.id;
  perform public.auction_reset_purses(a.id);
end $$;

create or replace function public.auction_unretain(p_player uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare pl public.auction_members; a public.auctions;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into pl from public.auction_members where id=p_player;
  if not found then raise exception 'Player not found.'; end if;
  select * into a from public.auctions where id=pl.auction_id;
  if a.status<>'open' then raise exception 'Retentions are locked once the auction starts.'; end if;
  delete from public.auction_picks where member_id=p_player and retained;
  update public.auction_members set lot_state='waiting' where id=p_player;
  perform public.auction_reset_purses(a.id);
end $$;

create or replace function public.auction_start(p_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; n int;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into a from public.auctions where id=p_id for update;
  if not found or a.status<>'open' then raise exception 'This auction cannot be started.'; end if;
  select count(*) into n from public.auction_members where auction_id=p_id and role='manager' and status='approved';
  if n<2 then raise exception 'Approve at least 2 managers first.'; end if;
  if not exists(select 1 from public.auction_members where auction_id=p_id and role='player' and status='approved' and lot_state='waiting') then raise exception 'There are no players in the pool.'; end if;
  perform public.auction_reset_purses(p_id);
  with o as (select id,row_number() over(order by tier,random()) rn from public.auction_members where auction_id=p_id and role='player' and status='approved' and lot_state='waiting')
  update public.auction_members m set lot_order=o.rn from o where m.id=o.id;
  update public.auctions set status='live',reg_open=false,lot_status='idle' where id=p_id;
end $$;

create or replace function public.auction_next_lot(p_id uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; m public.auction_members;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into a from public.auctions where id=p_id for update;
  if not found or a.status<>'live' then raise exception 'The auction is not live.'; end if;
  if a.lot_status<>'idle' then raise exception 'A player is already on the block.'; end if;
  select * into m from public.auction_members where auction_id=p_id and role='player' and status='approved' and lot_state='waiting' order by lot_order nulls last, created_at limit 1;
  if not found then return null; end if;
  update public.auction_members set lot_state='current' where id=m.id;
  update public.auctions set lot_status='open',cur_member=m.id,cur_bid=public.auction_base(a,m.tier),cur_leader=null,
    cur_ends=now()+make_interval(secs=>a.timer_secs),paused_left=null where id=p_id;
  return m.id;
end $$;

create or replace function public.auction_bid(p_id uuid, p_amount int) returns int
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; mg public.auction_members; n int; exp int;
begin
  if auth.uid() is null then raise exception 'Sign in to bid.'; end if;
  select * into a from public.auctions where id=p_id for update;
  if not found or a.status<>'live' then raise exception 'The auction is not live.'; end if;
  select * into mg from public.auction_members where auction_id=p_id and user_id=auth.uid() and role='manager' and status='approved';
  if not found then raise exception 'Only approved managers can bid.'; end if;
  if a.lot_status<>'open' or a.cur_member is null then raise exception 'No player is open for bidding.'; end if;
  if now()>a.cur_ends then raise exception 'Time is up for this player.'; end if;
  if a.cur_leader=mg.id then raise exception 'You are already the highest bidder.'; end if;
  exp:=case when a.cur_leader is null then a.cur_bid else a.cur_bid+a.bid_step end;
  if p_amount<>exp then raise exception 'The bid moved to %. Try again.',exp; end if;
  select count(*) into n from public.auction_picks where manager_id=mg.id;
  if n>=a.max_squad then raise exception 'Your squad is full.'; end if;
  if exp>public.auction_max_bid(p_id,mg.id) then raise exception 'Over your max bid of %. You must keep purse for your minimum squad.',public.auction_max_bid(p_id,mg.id); end if;
  insert into public.auction_bids(auction_id,member_id,manager_id,amount) values (p_id,a.cur_member,mg.id,exp);
  update public.auctions set cur_bid=exp,cur_leader=mg.id,cur_ends=greatest(cur_ends,now()+make_interval(secs=>least(8,timer_secs))) where id=p_id;
  return exp;
end $$;

create or replace function public.auction_close_lot(p_id uuid, p_force boolean default false) returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; adm boolean:=false; res text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  adm:=public.tournament_is_admin();
  select * into a from public.auctions where id=p_id for update;
  if not found or a.status<>'live' then raise exception 'The auction is not live.'; end if;
  if a.lot_status='idle' then return 'idle'; end if;
  if not adm then
    if not exists(select 1 from public.auction_members where auction_id=p_id and user_id=auth.uid() and role='manager' and status='approved') then raise exception 'Not allowed.'; end if;
    if a.lot_status<>'open' or now()<a.cur_ends then raise exception 'The timer is still running.'; end if;
  elsif a.lot_status='open' and now()<a.cur_ends and not p_force then raise exception 'The timer is still running.'; end if;
  if a.cur_leader is not null then
    insert into public.auction_picks(auction_id,manager_id,member_id,price) values (p_id,a.cur_leader,a.cur_member,a.cur_bid);
    update public.auction_members set purse=purse-a.cur_bid where id=a.cur_leader;
    update public.auction_members set lot_state='sold' where id=a.cur_member;
    res:='sold';
  else
    update public.auction_members set lot_state='unsold' where id=a.cur_member;
    res:='unsold';
  end if;
  update public.auctions set lot_status='idle',last_member=cur_member,last_leader=cur_leader,last_price=cur_bid,last_seq=last_seq+1,
    cur_member=null,cur_bid=null,cur_leader=null,cur_ends=null,paused_left=null where id=p_id;
  return res;
end $$;

create or replace function public.auction_pause(p_id uuid, p_pause boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into a from public.auctions where id=p_id for update;
  if not found or a.status<>'live' then raise exception 'The auction is not live.'; end if;
  if p_pause and a.lot_status='open' then
    update public.auctions set lot_status='paused',paused_left=greatest(1,ceil(extract(epoch from (cur_ends-now())))::int) where id=p_id;
  elsif not p_pause and a.lot_status='paused' then
    update public.auctions set lot_status='open',cur_ends=now()+make_interval(secs=>coalesce(paused_left,timer_secs)),paused_left=null where id=p_id;
  end if;
end $$;

create or replace function public.auction_requeue_unsold(p_id uuid) returns int
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; n int; base int;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into a from public.auctions where id=p_id for update;
  if not found or a.status<>'live' or a.lot_status<>'idle' then raise exception 'Close the current player first.'; end if;
  select coalesce(max(lot_order),0) into base from public.auction_members where auction_id=p_id;
  with o as (select id,row_number() over(order by tier,random()) rn from public.auction_members where auction_id=p_id and lot_state='unsold')
  update public.auction_members m set lot_state='waiting',lot_order=base+o.rn from o where m.id=o.id;
  get diagnostics n=row_count;
  return n;
end $$;

create or replace function public.auction_assign(p_player uuid, p_manager uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare pl public.auction_members; mg public.auction_members; a public.auctions; price int; n int;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into pl from public.auction_members where id=p_player and role='player';
  select * into mg from public.auction_members where id=p_manager and role='manager' and status='approved';
  if pl.id is null or mg.id is null or pl.auction_id<>mg.auction_id then raise exception 'Pick a player and a manager from this auction.'; end if;
  select * into a from public.auctions where id=pl.auction_id for update;
  if a.status<>'live' or a.lot_status<>'idle' then raise exception 'Close the current player first.'; end if;
  if pl.lot_state not in ('unsold','waiting') then raise exception 'That player already has a team.'; end if;
  select count(*) into n from public.auction_picks where manager_id=mg.id;
  if n>=a.max_squad then raise exception 'That squad is full.'; end if;
  price:=public.auction_base(a,pl.tier);
  if mg.purse<price then raise exception 'Not enough purse (needs %).',price; end if;
  insert into public.auction_picks(auction_id,manager_id,member_id,price) values (a.id,mg.id,pl.id,price);
  update public.auction_members set purse=purse-price where id=mg.id;
  update public.auction_members set lot_state='sold' where id=pl.id;
end $$;

create or replace function public.auction_assign_auto(p_id uuid) returns int
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.auctions; mg record; pl record; done int:=0; price int; progress boolean:=true;
begin
  if auth.uid() is null or not public.tournament_is_admin() then raise exception 'Admin access required.'; end if;
  select * into a from public.auctions where id=p_id for update;
  if not found or a.status<>'live' or a.lot_status<>'idle' then raise exception 'Close the current player first.'; end if;
  while progress loop
    progress:=false;
    for mg in select m.* from public.auction_members m where m.auction_id=p_id and m.role='manager' and m.status='approved'
      and (select count(*) from public.auction_picks k where k.manager_id=m.id)<a.min_squad order by m.purse desc loop
      select * into pl from public.auction_members where auction_id=p_id and role='player' and status='approved' and lot_state in ('unsold','waiting')
        order by public.auction_base(a,tier),random() limit 1;
      exit when pl.id is null;
      price:=public.auction_base(a,pl.tier);
      if (select purse from public.auction_members where id=mg.id)>=price then
        insert into public.auction_picks(auction_id,manager_id,member_id,price) values (p_id,mg.id,pl.id,price);
        update public.auction_members set purse=purse-price where id=mg.id;
        update public.auction_members set lot_state='sold' where id=pl.id;
        done:=done+1;progress:=true;
      end if;
    end loop;
  end loop;
  return done;
end $$;

create or replace function public.get_auction_list() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'name',a.name,'status',a.status,'reg_open',a.reg_open,'manager_slots',a.manager_slots,
    'managers',(select count(*) from public.auction_members m where m.auction_id=a.id and m.role='manager' and m.status='approved'),
    'players',(select count(*) from public.auction_members m where m.auction_id=a.id and m.role='player' and m.status='approved'),
    'my_role',(select m.role from public.auction_members m where m.auction_id=a.id and m.user_id=auth.uid() and m.status<>'removed'),
    'my_status',(select m.status from public.auction_members m where m.auction_id=a.id and m.user_id=auth.uid() and m.status<>'removed')
  ) order by a.created_at desc),'[]'::jsonb)
  from public.auctions a where a.status<>'archived' or public.tournament_is_admin();
$$;

create or replace function public.get_auction_bundle(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.auctions; me public.auction_members; r jsonb;
begin
  select * into a from public.auctions where id=p_id;
  if not found or (a.status='archived' and not public.tournament_is_admin()) then return null; end if;
  select * into me from public.auction_members where auction_id=p_id and user_id=auth.uid() and status<>'removed';
  r:=jsonb_build_object(
    'now',now(),
    'is_admin',coalesce(public.tournament_is_admin(),false),
    'auction',to_jsonb(a)-'created_by',
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'player_id',m.player_id,'name',p.display_name,'role',m.role,'status',m.status,'tier',m.tier,'purse',m.purse,'lot_state',m.lot_state,'lot_order',m.lot_order) order by m.created_at)
      from public.auction_members m join public.players p on p.id=m.player_id where m.auction_id=p_id and m.status<>'removed'),'[]'::jsonb),
    'picks',coalesce((select jsonb_agg(jsonb_build_object('manager_id',k.manager_id,'member_id',k.member_id,'price',k.price,'retained',k.retained) order by k.created_at) from public.auction_picks k where k.auction_id=p_id),'[]'::jsonb),
    'bids',coalesce((select jsonb_agg(jsonb_build_object('manager_id',b.manager_id,'amount',b.amount) order by b.id desc) from (select * from public.auction_bids where auction_id=p_id and member_id=a.cur_member order by id desc limit 30) b),'[]'::jsonb),
    'me',case when me.id is null then null else jsonb_build_object('member_id',me.id,'role',me.role,'status',me.status,
      'max_bid',case when me.role='manager' and me.status='approved' then public.auction_max_bid(p_id,me.id) else 0 end) end
  );
  return r;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'auction_create(text)','auction_set(uuid,jsonb)','auction_register(uuid,text)','auction_leave(uuid)',
    'auction_member_action(uuid,text,text)','auction_retain(uuid,uuid)','auction_unretain(uuid)','auction_start(uuid)',
    'auction_next_lot(uuid)','auction_bid(uuid,integer)','auction_close_lot(uuid,boolean)','auction_pause(uuid,boolean)',
    'auction_requeue_unsold(uuid)','auction_assign(uuid,uuid)','auction_assign_auto(uuid)','get_auction_list()','get_auction_bundle(uuid)',
    'auction_reset_purses(uuid)','auction_max_bid(uuid,uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated',f);
  end loop;
  foreach f in array array['get_auction_list()','get_auction_bundle(uuid)'] loop
    execute format('grant execute on function public.%s to anon, authenticated',f);
  end loop;
  foreach f in array array[
    'auction_create(text)','auction_set(uuid,jsonb)','auction_register(uuid,text)','auction_leave(uuid)',
    'auction_member_action(uuid,text,text)','auction_retain(uuid,uuid)','auction_unretain(uuid)','auction_start(uuid)',
    'auction_next_lot(uuid)','auction_bid(uuid,integer)','auction_close_lot(uuid,boolean)','auction_pause(uuid,boolean)',
    'auction_requeue_unsold(uuid)','auction_assign(uuid,uuid)','auction_assign_auto(uuid)'] loop
    execute format('grant execute on function public.%s to authenticated',f);
  end loop;
end $$;
