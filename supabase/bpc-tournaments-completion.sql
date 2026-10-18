-- BPC Tournaments completion migration (v2).
-- Apply after bpc-tournaments-core.sql and bpc-tournaments-workflows.sql.
-- Adds secure self-registration, team registration/rosters, admin stage/fixture controls,
-- result review queue access, and standings query. Tournament-only objects.

create or replace function public.tournament_register_individual(p_tournament_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_t public.tournament_tournaments%rowtype; v_id uuid; v_count integer;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 select * into v_t from public.tournament_tournaments where id=p_tournament_id for update;
 if not found or v_t.status<>'registration_open' then raise exception 'Registration is not open'; end if;
 if v_t.competition_type<>'individual' then raise exception 'This tournament requires team registration'; end if;
 if v_t.registration_mode not in ('self','both') then raise exception 'Self-registration is disabled'; end if;
 if v_t.registration_deadline is not null and v_t.registration_deadline<now() then raise exception 'Registration deadline has passed'; end if;
 if exists(select 1 from public.tournament_participants where tournament_id=p_tournament_id and user_id=auth.uid() and status not in ('withdrawn','rejected')) then raise exception 'You are already registered'; end if;
 select count(*) into v_count from public.tournament_participants where tournament_id=p_tournament_id and status in ('pending','confirmed','waitlisted');
 insert into public.tournament_participants(tournament_id,entrant_type,user_id,registration_source,status,created_by,approved_by,approved_at)
 values(p_tournament_id,'individual',auth.uid(),'self',
   case when v_t.registration_requires_approval then 'pending' when v_t.participant_limit is not null and v_count>=v_t.participant_limit then 'waitlisted' else 'confirmed' end,
   auth.uid(),case when not v_t.registration_requires_approval and (v_t.participant_limit is null or v_count<v_t.participant_limit) then auth.uid() end,
   case when not v_t.registration_requires_approval and (v_t.participant_limit is null or v_count<v_t.participant_limit) then now() end)
 returning id into v_id;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id)
 values(v_t.id,auth.uid(),'self_registration','participant',v_id::text);
 return v_id;
end $$;

create or replace function public.tournament_register_team(p_tournament_id uuid,p_team_name text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_t public.tournament_tournaments%rowtype; v_participant uuid; v_team uuid; v_count integer;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if length(trim(p_team_name)) not between 2 and 100 then raise exception 'Team name must be 2–100 characters'; end if;
 select * into v_t from public.tournament_tournaments where id=p_tournament_id for update;
 if not found or v_t.status<>'registration_open' then raise exception 'Registration is not open'; end if;
 if v_t.competition_type<>'team' then raise exception 'This tournament is for individuals'; end if;
 if v_t.registration_mode not in ('self','both') then raise exception 'Self-registration is disabled'; end if;
 if v_t.registration_deadline is not null and v_t.registration_deadline<now() then raise exception 'Registration deadline has passed'; end if;
 if exists(select 1 from public.tournament_teams where tournament_id=p_tournament_id and lower(team_name)=lower(trim(p_team_name))) then raise exception 'That team name is already used'; end if;
 select count(*) into v_count from public.tournament_participants where tournament_id=p_tournament_id and status in ('pending','confirmed','waitlisted');
 insert into public.tournament_participants(tournament_id,entrant_type,user_id,registration_source,status,created_by,approved_by,approved_at)
 values(p_tournament_id,'team',auth.uid(),'self',
 case when v_t.registration_requires_approval then 'pending' when v_t.participant_limit is not null and v_count>=v_t.participant_limit then 'waitlisted' else 'confirmed' end,
 auth.uid(),case when not v_t.registration_requires_approval and (v_t.participant_limit is null or v_count<v_t.participant_limit) then auth.uid() end,
 case when not v_t.registration_requires_approval and (v_t.participant_limit is null or v_count<v_t.participant_limit) then now() end)
 returning id into v_participant;
 insert into public.tournament_teams(tournament_id,participant_id,team_name,captain_user_id)
 values(p_tournament_id,v_participant,trim(p_team_name),auth.uid()) returning id into v_team;
 insert into public.tournament_team_members(team_id,user_id,role) values(v_team,auth.uid(),'captain');
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id)
 values(v_t.id,auth.uid(),'team_registration','team',v_team::text);
 return v_team;
end $$;

create or replace function public.tournament_team_add_member(p_team_id uuid,p_user_id uuid default null,p_cobeg_member_id uuid default null,p_external_name text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_team public.tournament_teams%rowtype; v_id uuid;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if num_nonnulls(p_user_id,p_cobeg_member_id,nullif(trim(p_external_name),''))<>1 then raise exception 'Provide exactly one member identity'; end if;
 select * into v_team from public.tournament_teams where id=p_team_id for update;
 if not found then raise exception 'Team not found'; end if;
 if not public.tournament_is_admin() and v_team.captain_user_id<>auth.uid() then raise exception 'Only the captain or an administrator may manage this roster'; end if;
 if exists(select 1 from public.tournament_participants where id=v_team.participant_id and status not in ('pending','confirmed')) then raise exception 'Team is not active'; end if;
 insert into public.tournament_team_members(team_id,user_id,cobeg_member_id,external_name)
 values(p_team_id,p_user_id,p_cobeg_member_id,case when p_user_id is null and p_cobeg_member_id is null then trim(p_external_name) end)
 returning id into v_id;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id)
 values(v_team.tournament_id,auth.uid(),'team_member_added','team_member',v_id::text);
 return v_id;
end $$;

create or replace function public.tournament_admin_review_registration(p_participant_id uuid,p_decision text,p_reason text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_p public.tournament_participants%rowtype;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 if p_decision not in ('confirmed','rejected','waitlisted') then raise exception 'Invalid registration decision'; end if;
 select * into v_p from public.tournament_participants where id=p_participant_id for update;
 if not found or v_p.status<>'pending' then raise exception 'Registration is not pending'; end if;
 update public.tournament_participants set status=p_decision,approved_by=case when p_decision='confirmed' then auth.uid() end,approved_at=case when p_decision='confirmed' then now() end where id=v_p.id;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason)
 values(v_p.tournament_id,auth.uid(),'registration_'||p_decision,'participant',v_p.id::text,p_reason);
 return v_p.id;
end $$;

create or replace function public.tournament_admin_generate_round(
 p_stage_id uuid,p_round integer,p_publish boolean default false,p_reason text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_s public.tournament_stages%rowtype; v_t public.tournament_tournaments%rowtype;
 v_run uuid; v_ids uuid[]; v_n integer; v_i integer; v_a uuid; v_b uuid; v_match integer:=0; v_run_no integer;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 if p_round<1 then raise exception 'Round must be positive'; end if;
 select * into v_s from public.tournament_stages where id=p_stage_id for update;
 if not found then raise exception 'Stage not found'; end if;
 select * into v_t from public.tournament_tournaments where id=v_s.tournament_id for update;
 if exists(select 1 from public.tournament_pairing_runs where stage_id=p_stage_id and round_number=p_round and status='published') then raise exception 'Round is already published'; end if;
 if p_round>1 and exists(select 1 from public.tournament_matches where stage_id=p_stage_id and round_number=p_round-1 and status not in ('approved','completed','bye','cancelled')) then raise exception 'Resolve the previous round first'; end if;
 select coalesce(max(run_number),0)+1 into v_run_no from public.tournament_pairing_runs where stage_id=p_stage_id and round_number=p_round;
 insert into public.tournament_pairing_runs(tournament_id,stage_id,round_number,run_number,status,config_json,generated_by,published_at,reason)
 values(v_t.id,p_stage_id,p_round,v_run_no,case when p_publish then 'published' else 'preview' end,jsonb_build_object('algorithm',v_s.stage_type),auth.uid(),case when p_publish then now() end,p_reason) returning id into v_run;
 if v_s.stage_type='knockout' and p_round>1 then
   select array_agg(winner_participant_id order by match_number) into v_ids from public.tournament_matches where stage_id=p_stage_id and round_number=p_round-1 and status in ('approved','completed','bye') and winner_participant_id is not null;
 else
   select array_agg(se.participant_id order by coalesce(se.seed,2147483647),se.participant_id) into v_ids
   from public.tournament_stage_entries se join public.tournament_participants p on p.id=se.participant_id
   where se.stage_id=p_stage_id and se.entry_status in ('active','qualified') and p.status='confirmed';
 end if;
 v_n:=coalesce(array_length(v_ids,1),0);
 if v_n<2 then raise exception 'At least two eligible entrants are required'; end if;
 if v_s.stage_type in ('round_robin','group') then
   if v_n%2=1 then v_ids:=array_append(v_ids,null); v_n:=v_n+1; end if;
   if p_round>v_n-1 then raise exception 'Round exceeds round-robin schedule'; end if;
   -- Rotate all but the first seed according to the circle method.
   for v_i in 1..((v_n/2)-1) loop
     v_a:=v_ids[v_i]; v_b:=v_ids[v_n-v_i+1];
     if v_a is not null and v_b is not null then
       v_match:=v_match+1;
       insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
       values(v_t.id,p_stage_id,p_round,v_match,v_a,v_b,v_run,'scheduled');
     end if;
   end loop;
   v_a:=v_ids[v_n/2]; v_b:=v_ids[v_n/2+1];
   if v_a is not null and v_b is not null then
     v_match:=v_match+1;
     insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
     values(v_t.id,p_stage_id,p_round,v_match,v_a,v_b,v_run,'scheduled');
   end if;
 elsif v_s.stage_type in ('knockout','swiss') then
   if v_n%2=1 then
     v_a:=v_ids[v_n]; v_n:=v_n-1;
     insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,winner_participant_id,pairing_run_id,status)
     values(v_t.id,p_stage_id,p_round,(v_n/2)+1,v_a,v_a,v_run,'bye');
   end if;
   for v_i in 1..(v_n/2) loop
     v_a:=v_ids[2*v_i-1]; v_b:=v_ids[2*v_i];
     if v_a=v_b then raise exception 'Self-pairing forbidden'; end if;
     if v_s.stage_type='swiss' and exists(select 1 from public.tournament_matches m where m.stage_id=p_stage_id and ((m.participant_a_id=v_a and m.participant_b_id=v_b) or (m.participant_a_id=v_b and m.participant_b_id=v_a))) then raise exception 'Swiss repeat pairing detected; adjust seeds and retry'; end if;
     v_match:=v_match+1;
     insert into public.tournament_matches(tournament_id,stage_id,round_number,match_number,participant_a_id,participant_b_id,pairing_run_id,status)
     values(v_t.id,p_stage_id,p_round,v_match,v_a,v_b,v_run,'scheduled');
   end loop;
 end if;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason,details_json)
 values(v_t.id,auth.uid(),case when p_publish then 'round_published' else 'round_preview_generated' end,'stage',p_stage_id::text,p_reason,jsonb_build_object('round',p_round,'run',v_run,'match_count',v_match));
 return v_run;
end $$;

create or replace function public.tournament_standings_for_stage(p_stage_id uuid)
returns table(participant_id uuid,entrant_name text,played bigint,wins bigint,draws bigint,losses bigint,score_for bigint,score_against bigint,score_difference bigint,points numeric)
language sql stable security definer set search_path=public,pg_temp as $$
 with st as (select s.id,s.tournament_id,t.scoring_config_json from public.tournament_stages s join public.tournament_tournaments t on t.id=s.tournament_id where s.id=p_stage_id and public.tournament_can_view(s.tournament_id)),
 entrants as (
  select e.participant_id,coalesce(tt.team_name,nullif(p.external_name,''),pr.display_name,cm.name,'Entrant') entrant_name,st.scoring_config_json
  from public.tournament_stage_entries e join st on st.id=e.stage_id
  join public.tournament_participants p on p.id=e.participant_id and p.status='confirmed'
  left join public.tournament_teams tt on tt.participant_id=p.id
  left join public.profiles pr on pr.id=p.user_id left join public.cobeg_members cm on cm.id=p.cobeg_member_id
  where e.entry_status in ('active','qualified')
 ), calc as (
  select e.participant_id,e.entrant_name,
  count(m.id) filter(where m.status='approved') played,
  count(m.id) filter(where m.status='approved' and m.winner_participant_id=e.participant_id) wins,
  count(m.id) filter(where m.status='approved' and m.winner_participant_id is null and m.score_a=m.score_b) draws,
  count(m.id) filter(where m.status='approved' and m.winner_participant_id is not null and m.winner_participant_id<>e.participant_id) losses,
  coalesce(sum(case when m.status='approved' and m.participant_a_id=e.participant_id then m.score_a when m.status='approved' and m.participant_b_id=e.participant_id then m.score_b else 0 end),0) sf,
  coalesce(sum(case when m.status='approved' and m.participant_a_id=e.participant_id then m.score_b when m.status='approved' and m.participant_b_id=e.participant_id then m.score_a else 0 end),0) sa,
  coalesce(sum(case when m.status='approved' and m.winner_participant_id=e.participant_id then coalesce((e.scoring_config_json->>'win')::numeric,3) when m.status='approved' and m.winner_participant_id is null and m.score_a=m.score_b then coalesce((e.scoring_config_json->>'draw')::numeric,1) else 0 end),0) pts
  from entrants e left join public.tournament_matches m on m.stage_id=p_stage_id and (m.participant_a_id=e.participant_id or m.participant_b_id=e.participant_id)
  group by e.participant_id,e.entrant_name,e.scoring_config_json
 )
 select participant_id,entrant_name,played,wins,draws,losses,sf,sa,sf-sa,pts from calc order by pts desc,sf-sa desc,sf desc,wins desc,entrant_name
$$;

revoke all on function public.tournament_register_individual(uuid) from public,anon;
revoke all on function public.tournament_register_team(uuid,text) from public,anon;
revoke all on function public.tournament_team_add_member(uuid,uuid,uuid,text) from public,anon;
revoke all on function public.tournament_admin_review_registration(uuid,text,text) from public,anon;
revoke all on function public.tournament_admin_generate_round(uuid,integer,boolean,text) from public,anon;
grant execute on function public.tournament_register_individual(uuid) to authenticated;
grant execute on function public.tournament_register_team(uuid,text) to authenticated;
grant execute on function public.tournament_team_add_member(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.tournament_admin_review_registration(uuid,text,text) to authenticated;
grant execute on function public.tournament_admin_generate_round(uuid,integer,boolean,text) to authenticated;
grant execute on function public.tournament_standings_for_stage(uuid) to authenticated;
