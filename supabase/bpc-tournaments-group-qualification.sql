-- Group-stage qualification for group_knockout tournaments.
-- Only tournament_* objects are touched.
create or replace function public.tournament_admin_advance_group_qualifiers(
 p_tournament_id uuid,
 p_qualifiers_per_group integer default 2
) returns integer
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
 v_t public.tournament_tournaments%rowtype;
 v_group_stage uuid;
 v_ko_stage uuid;
 v_added integer;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 if p_qualifiers_per_group<1 or p_qualifiers_per_group>8 then raise exception 'Qualifiers per group must be 1–8'; end if;
 select * into v_t from public.tournament_tournaments where id=p_tournament_id for update;
 if not found or v_t.format<>'group_knockout' then raise exception 'This is not a group stage + knockout tournament'; end if;
 select id into v_group_stage from public.tournament_stages where tournament_id=p_tournament_id and stage_type='group' order by sequence_number limit 1;
 select id into v_ko_stage from public.tournament_stages where tournament_id=p_tournament_id and stage_type='knockout' order by sequence_number limit 1;
 if v_group_stage is null or v_ko_stage is null then raise exception 'Default group and knockout stages must be set up first'; end if;
 if exists(select 1 from public.tournament_stage_entries where stage_id=v_ko_stage) then raise exception 'Knockout qualifiers have already been added'; end if;
 if exists(select 1 from public.tournament_matches where stage_id=v_group_stage and status not in ('approved','completed','bye','cancelled')) then raise exception 'Finish all group matches before advancing qualifiers'; end if;
 with entrants as (
   select e.participant_id,e.group_id,coalesce(e.seed,2147483647) seed,
     count(m.id) filter(where m.status in ('approved','completed')) played,
     count(m.id) filter(where m.status in ('approved','completed') and m.winner_participant_id=e.participant_id) wins,
     count(m.id) filter(where m.status in ('approved','completed') and m.winner_participant_id is null and m.score_a=m.score_b) draws,
     coalesce(sum(case when m.status in ('approved','completed') and m.participant_a_id=e.participant_id then m.score_a when m.status in ('approved','completed') and m.participant_b_id=e.participant_id then m.score_b else 0 end),0) gf,
     coalesce(sum(case when m.status in ('approved','completed') and m.participant_a_id=e.participant_id then m.score_b when m.status in ('approved','completed') and m.participant_b_id=e.participant_id then m.score_a else 0 end),0) ga,
     coalesce(sum(case when m.status in ('approved','completed') and m.winner_participant_id=e.participant_id then coalesce((v_t.scoring_config_json->>'win')::numeric,3)
       when m.status in ('approved','completed') and m.winner_participant_id is null and m.score_a=m.score_b then coalesce((v_t.scoring_config_json->>'draw')::numeric,1) else 0 end),0) points
   from public.tournament_stage_entries e
   join public.tournament_participants p on p.id=e.participant_id and p.status='confirmed'
   left join public.tournament_matches m on m.stage_id=v_group_stage and m.group_id=e.group_id and (m.participant_a_id=e.participant_id or m.participant_b_id=e.participant_id)
   where e.stage_id=v_group_stage and e.group_id is not null and e.entry_status in ('active','qualified')
   group by e.participant_id,e.group_id,e.seed
 ), ranked as (
   select *,row_number() over(partition by group_id order by points desc,(gf-ga) desc,gf desc,wins desc,seed,participant_id) as group_rank
   from entrants
 )
 insert into public.tournament_stage_entries(stage_id,participant_id,seed,entry_status)
 select v_ko_stage,participant_id,row_number() over(order by group_rank,seed,participant_id),'active'
 from ranked where group_rank<=p_qualifiers_per_group;
 get diagnostics v_added = row_count;
 if v_added<2 then raise exception 'Fewer than two qualifiers found; check group assignments and completed results'; end if;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,details_json)
 values(p_tournament_id,auth.uid(),'group_qualifiers_advanced','stage',v_ko_stage::text,
   jsonb_build_object('group_stage_id',v_group_stage,'qualifiers_per_group',p_qualifiers_per_group,'qualifier_count',v_added));
 return v_added;
end $$;
revoke all on function public.tournament_admin_advance_group_qualifiers(uuid,integer) from public,anon;
grant execute on function public.tournament_admin_advance_group_qualifiers(uuid,integer) to authenticated;
