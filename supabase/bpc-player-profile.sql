-- Public player profile data: every counted, approved match from one active player's point of view.
create or replace function public.get_player_matches(p_player uuid)
returns table(match_id uuid, match_date date, opponent_name text, opponent_id uuid, gf integer, ga integer)
language sql stable security definer set search_path=public,pg_temp
as $$
  with me as (select id, display_name from public.players where id=p_player and active)
  select m.id, m.match_date, coalesce(op.display_name, m.opponent_name), op.id, m.player_goals, m.opponent_goals
    from public.matches m
    join me on m.player_id=me.id
    left join public.players op on op.active and op.id<>me.id
         and public.normalize_opponent_key(op.display_name)=m.opponent_key
   where m.status='approved' and m.counted
  union all
  select m.id, m.match_date, sub.display_name, case when sub.active then sub.id end, m.opponent_goals, m.player_goals
    from public.matches m
    join me on public.normalize_opponent_key(me.display_name)=m.opponent_key
    join public.players sub on sub.id=m.player_id and sub.id<>me.id
   where m.status='approved' and m.counted
  order by 2 desc, 1;
$$;
revoke all on function public.get_player_matches(uuid) from public;
grant execute on function public.get_player_matches(uuid) to anon, authenticated;
