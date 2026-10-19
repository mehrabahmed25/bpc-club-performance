-- Public Head to Head + Top scorer / clean sheets (counted, approved matches; active players only).
create or replace function public.get_head_to_head(p_a uuid, p_b uuid)
returns table(match_id uuid, match_date date, a_goals integer, b_goals integer)
language sql stable security definer set search_path=public,pg_temp
as $$
  with a as (select id, display_name from public.players where id=p_a and active),
       b as (select id, display_name from public.players where id=p_b and active)
  select m.id, m.match_date, m.player_goals, m.opponent_goals
    from public.matches m, a, b
   where p_a<>p_b and m.status='approved' and m.counted
     and m.player_id=a.id and m.opponent_key=public.normalize_opponent_key(b.display_name)
  union all
  select m.id, m.match_date, m.opponent_goals, m.player_goals
    from public.matches m, a, b
   where p_a<>p_b and m.status='approved' and m.counted
     and m.player_id=b.id and m.opponent_key=public.normalize_opponent_key(a.display_name)
  order by 2 desc, 1;
$$;

create or replace function public.get_top_performers(p_month date default null)
returns table(player_id uuid, player_name text, matches_played bigint, goals_for bigint, goals_against bigint, clean_sheets bigint)
language sql stable security definer set search_path=public,pg_temp
as $$
  with am as (
    select m.* from public.matches m
     where m.status='approved' and m.counted
       and (p_month is null or (m.match_date >= date_trunc('month',p_month)::date
                            and m.match_date <  (date_trunc('month',p_month)+interval '1 month')::date))
  ), persp as (
    select m.id mid, m.player_id pid, m.player_goals gf, m.opponent_goals ga from am m
    union all
    select m.id, other.id, m.opponent_goals, m.player_goals
      from am m
      join public.players other on other.active and other.id<>m.player_id
       and public.normalize_opponent_key(other.display_name)=m.opponent_key
  )
  select p.id, p.display_name, count(v.mid)::bigint, coalesce(sum(v.gf),0)::bigint,
         coalesce(sum(v.ga),0)::bigint, count(v.mid) filter (where v.ga=0)::bigint
    from public.players p left join persp v on v.pid=p.id
   where p.active group by p.id, p.display_name having count(v.mid)>0;
$$;
revoke all on function public.get_head_to_head(uuid,uuid) from public;
revoke all on function public.get_top_performers(date) from public;
grant execute on function public.get_head_to_head(uuid,uuid) to anon, authenticated;
grant execute on function public.get_top_performers(date) to anon, authenticated;
