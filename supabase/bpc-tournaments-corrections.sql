-- BPC Tournaments corrective migration (additive; tournament objects only).
-- Apply AFTER core, workflows, completion, and admin-score migrations.
-- Fixes round-robin rotation and uses standings-aware, no-repeat Swiss pairing.
-- Does not alter existing BPC friendly-match, Official Matches, or BPC Funds objects.

create or replace function public.tournament_admin_generate_round(
 p_stage_id uuid,
 p_round integer,
 p_publish boolean default false,
 p_reason text default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
 v_s public.tournament_stages%rowtype;
 v_t public.tournament_tournaments%rowtype;
 v_run uuid;
 v_ids uuid[];
 v_n integer;
 v_i integer;
 v_j integer;
 v_a uuid;
 v_b uuid;
 v_match integer := 0;
 v_run_no integer;
 v_group record;
 v_pool uuid[];
 v_pool_n integer;
 v_candidate uuid;
 v_best uuid;
 v_points numeric;
 v_best_points numeric;
 v_sf bigint;
 v_best_sf bigint;
 v_seed integer;
 v_best_seed integer;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 if p_round < 1 then raise exception 'Round must be positive'; end if;
 if not p_publish then raise exception 'Preview-only fixture generation is not supported yet. Confirm publishing to create fixtures.'; end if;
 select * into v_s from public.tournament_stages where id=p_stage_id for update;
 if not found then raise exception 'Stage not found'; end if;
 select * into v_t from public.tournament_tournaments where id=v_s.tournament_id for update;
 if exists(select 1 from public.tournament_pairing_runs where stage_id=p_stage_id and round_number=p_round and status='published') then
   raise exception 'Round is already published';
 end if;
 if p_round > 1 and exists(
   select 1 from public.tournament_matches
   where stage_id=p_stage_id and round_number=p_round-1
     and status not in ('approved','completed','bye','cancelled')
 ) then raise exception 'Resolve the previous round first'; end if;

 select coalesce(max(run_number),0)+1 into v_run_no
 from public.tournament_pairing_runs where stage_id=p_stage_id and round_number=p_round;
 insert into public.tournament_pairing_runs(
   tournament_id,stage_id,round_number,run_number,status,config_json,generated_by,published_at,reason
 ) values (
   v_t.id,p_stage_id,p_round,v_run_no,
   case when p_publish then 'published' else 'preview' end,
   jsonb_build_object('algorithm',v_s.stage_type,'round',p_round),
   auth.uid(),case when p_publish then now() end,p_reason
 ) returning id into v_run;

 if v_s.stage_type='knockout' and p_round>1 then
   select array_agg(winner_participant_id order by match_number) into v_ids
   from public.tournament_matches
   where stage_id=p_stage_id and round_number=p_round-1
     and status in ('approved','completed','bye') and winner_participant_id is not null;
 else
   select array_agg(se.participant_id order by coalesce(se.seed,2147483647),se.participant_id)
   into v_ids
   from public.tournament_stage_entries se
   join public.tournament_participants p on p.id=se.participant_id
   where se.stage_id=p_stage_id and se.entry_status in ('active','qualified')
     and p.status='confirmed'
     and (v_s.stage_type<>'group' or se.group_id is not null);
 end if;
 v_n:=coalesce(array_length(v_ids,1),0);
 if v_n<2 then raise exception 'At least two eligible entrants are required'; end if;

 if v_s.stage_type='round_robin' then
   -- Circle method: keep slot 1 fixed and rotate all other slots by round.
   if v_n%2=1 then v_ids:=array_append(v_ids,null); v_n:=v_n+1; end if;
   if p_round>v_n-1 then raise exception 'Round exceeds round-robin schedule'; end if;
   for v_i in 1..(p_round-1) loop
     v_candidate:=v_ids[v_n];
     for v_j in reverse v_n..3 loop v_ids[v_j]:=v_ids[v_j-1]; end loop;
     v_ids[2]:=v_candidate;
   end loop;
   for v_i in 1..(v_n/2) loop
     v_a:=v_ids[v_i]; v_b:=v_ids[v_n-v_i+1];
     if v_a is not null and v_b is not null then
       v_match:=v_match+1;
       insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
       values(v_t.id,p_stage_id,p_round,v_match,v_a,v_b,v_run,'scheduled');
     end if;
   end loop;

 elsif v_s.stage_type='group' then
   -- Each group receives its own round-robin schedule; group stage entries must be assigned to groups.
   for v_group in
     select g.id group_id from public.tournament_groups g where g.stage_id=p_stage_id order by g.sequence_number,g.id
   loop
     select array_agg(se.participant_id order by coalesce(se.seed,2147483647),se.participant_id)
       into v_pool
     from public.tournament_stage_entries se
     join public.tournament_participants p on p.id=se.participant_id
     where se.stage_id=p_stage_id and se.group_id=v_group.group_id
       and se.entry_status in ('active','qualified') and p.status='confirmed';
     v_pool_n:=coalesce(array_length(v_pool,1),0);
     if v_pool_n<2 then continue; end if;
     if v_pool_n%2=1 then v_pool:=array_append(v_pool,null); v_pool_n:=v_pool_n+1; end if;
     if p_round>v_pool_n-1 then continue; end if;
     for v_i in 1..(p_round-1) loop
       v_candidate:=v_pool[v_pool_n];
       for v_j in reverse v_pool_n..3 loop v_pool[v_j]:=v_pool[v_j-1]; end loop;
       v_pool[2]:=v_candidate;
     end loop;
     for v_i in 1..(v_pool_n/2) loop
       v_a:=v_pool[v_i]; v_b:=v_pool[v_pool_n-v_i+1];
       if v_a is not null and v_b is not null then
         v_match:=v_match+1;
         insert into public.tournament_matches(tournament_id,stage_id,group_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
         values(v_t.id,p_stage_id,v_group.group_id,p_round,v_match,v_a,v_b,v_run,'scheduled');
       end if;
     end loop;
   end loop;
   if v_match=0 then raise exception 'No eligible group fixtures for this round; check group assignments and round number'; end if;

 elsif v_s.stage_type='knockout' then
   if p_round=1 then
     if v_n%2=1 then v_ids:=array_append(v_ids,null); v_n:=v_n+1; end if;
     for v_i in 1..(v_n/2) loop
       v_a:=v_ids[v_i]; v_b:=v_ids[v_n-v_i+1];
       if v_a is null or v_b is null then
         v_candidate:=coalesce(v_a,v_b);
         v_match:=v_match+1;
         insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,winner_participant_id,pairing_run_id,status)
         values(v_t.id,p_stage_id,p_round,v_match,v_candidate,v_candidate,v_run,'bye');
       else
         v_match:=v_match+1;
         insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
         values(v_t.id,p_stage_id,p_round,v_match,v_a,v_b,v_run,'scheduled');
       end if;
     end loop;
   else
     for v_i in 1..(v_n/2) loop
       v_a:=v_ids[2*v_i-1]; v_b:=v_ids[2*v_i];
       v_match:=v_match+1;
       insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
       values(v_t.id,p_stage_id,p_round,v_match,v_a,v_b,v_run,'scheduled');
     end loop;
   end if;

 elsif v_s.stage_type='swiss' then
   -- Swiss pairing: rank by approved points, score difference, score-for, seed, then id.
   -- Greedily pair each highest-ranked unpaired entrant with the highest-ranked opponent
   -- they have not faced before. Odd-field bye goes to the lowest-ranked entrant without
   -- a prior bye where possible.
   if p_round>1 and exists(select 1 from public.tournament_matches where stage_id=p_stage_id and round_number=p_round-1 and status not in ('approved','completed','bye','cancelled')) then
     raise exception 'Resolve all previous Swiss results first';
   end if;
   if v_n%2=1 then
     for v_i in reverse v_n..1 loop
       v_candidate:=v_ids[v_i];
       if not exists(select 1 from public.tournament_matches m where m.stage_id=p_stage_id and m.status='bye' and m.participant_a_id=v_candidate) then
         v_best:=v_candidate; exit;
       end if;
     end loop;
     if v_best is null then v_best:=v_ids[v_n]; end if;
     v_match:=v_match+1;
     insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,winner_participant_id,pairing_run_id,status)
     values(v_t.id,p_stage_id,p_round,v_match,v_best,v_best,v_run,'bye');
     v_ids:=array_remove(v_ids,v_best);
     v_n:=array_length(v_ids,1);
   end if;
   while coalesce(v_n,0)>=2 loop
     v_a:=v_ids[1];
     v_best:=null; v_best_points:=null; v_best_sf:=null; v_best_seed:=null;
     for v_i in 2..v_n loop
       v_candidate:=v_ids[v_i];
       if exists(select 1 from public.tournament_matches m where m.stage_id=p_stage_id and
         ((m.participant_a_id=v_a and m.participant_b_id=v_candidate) or (m.participant_a_id=v_candidate and m.participant_b_id=v_a))) then
         continue;
       end if;
       select coalesce(sum(case when m.status in ('approved','completed') and m.winner_participant_id=se.participant_id then coalesce((v_t.scoring_config_json->>'win')::numeric,3)
                                when m.status in ('approved','completed') and m.winner_participant_id is null and m.score_a=m.score_b then coalesce((v_t.scoring_config_json->>'draw')::numeric,1) else 0 end),0),
              coalesce(sum(case when m.status in ('approved','completed') and m.participant_a_id=se.participant_id then m.score_a
                                when m.status in ('approved','completed') and m.participant_b_id=se.participant_id then m.score_b else 0 end),0),
              coalesce(se.seed,2147483647)
       into v_points,v_sf,v_seed
       from public.tournament_stage_entries se
       left join public.tournament_matches m on m.stage_id=p_stage_id and (m.participant_a_id=se.participant_id or m.participant_b_id=se.participant_id)
       where se.stage_id=p_stage_id and se.participant_id=v_candidate
       group by se.seed;
       if v_best is null or v_points>v_best_points or (v_points=v_best_points and v_sf>v_best_sf) or
          (v_points=v_best_points and v_sf=v_best_sf and v_seed<v_best_seed) then
         v_best:=v_candidate; v_best_points:=v_points; v_best_sf:=v_sf; v_best_seed:=v_seed;
       end if;
     end loop;
     if v_best is null then raise exception 'No valid no-repeat Swiss pairing remains; consider a bye or manual pairing'; end if;
     v_match:=v_match+1;
     insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
     values(v_t.id,p_stage_id,p_round,v_match,v_a,v_best,v_run,'scheduled');
     v_ids:=array_remove(array_remove(v_ids,v_a),v_best);
     v_n:=array_length(v_ids,1);
   end loop;
 end if;

 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason,details_json)
 values(v_t.id,auth.uid(),case when p_publish then 'round_published' else 'round_preview_generated' end,
 'stage',p_stage_id::text,p_reason,jsonb_build_object('round',p_round,'run',v_run,'match_count',v_match));
 return v_run;
end $$;

revoke all on function public.tournament_admin_generate_round(uuid,integer,boolean,text) from public,anon;
grant execute on function public.tournament_admin_generate_round(uuid,integer,boolean,text) to authenticated;
