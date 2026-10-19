-- Tournament security and setup completion migration.
-- Only tournament_* objects are changed. Existing BPC features are untouched.

create or replace function public.tournament_admin_setup_stages(
 p_tournament_id uuid,
 p_group_count integer default 4
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
 v_t public.tournament_tournaments%rowtype;
 v_stage uuid;
 v_ko uuid;
 v_group uuid;
 v_groups integer;
 v_i integer;
 v_part record;
 v_result jsonb := '{}'::jsonb;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 select * into v_t from public.tournament_tournaments where id=p_tournament_id for update;
 if not found then raise exception 'Tournament not found'; end if;
 if exists(select 1 from public.tournament_stages where tournament_id=p_tournament_id) then
   raise exception 'Stages already exist; this setup helper only works before any stages are created';
 end if;
 if v_t.format='round_robin' then
   insert into public.tournament_stages(tournament_id,name,stage_type,sequence_number,status)
   values(p_tournament_id,'Round Robin','round_robin',1,'active') returning id into v_stage;
   insert into public.tournament_stage_entries(stage_id,participant_id,seed)
   select v_stage,id,seed from public.tournament_participants where tournament_id=p_tournament_id and status='confirmed';
   v_result:=jsonb_build_object('format','round_robin','stage_id',v_stage);
 elsif v_t.format='knockout' then
   insert into public.tournament_stages(tournament_id,name,stage_type,sequence_number,status)
   values(p_tournament_id,'Knockout','knockout',1,'active') returning id into v_stage;
   insert into public.tournament_stage_entries(stage_id,participant_id,seed)
   select v_stage,id,seed from public.tournament_participants where tournament_id=p_tournament_id and status='confirmed';
   v_result:=jsonb_build_object('format','knockout','stage_id',v_stage);
 elsif v_t.format='swiss' then
   insert into public.tournament_stages(tournament_id,name,stage_type,sequence_number,status)
   values(p_tournament_id,'Swiss Stage','swiss',1,'active') returning id into v_stage;
   insert into public.tournament_stage_entries(stage_id,participant_id,seed)
   select v_stage,id,seed from public.tournament_participants where tournament_id=p_tournament_id and status='confirmed';
   v_result:=jsonb_build_object('format','swiss','stage_id',v_stage);
 elsif v_t.format='group_knockout' then
   select count(*) into v_i from public.tournament_participants where tournament_id=p_tournament_id and status='confirmed';
   v_groups:=greatest(2,least(coalesce(p_group_count,4),8));
   if v_i < v_groups*2 then raise exception 'Need at least two confirmed entrants per group'; end if;
   insert into public.tournament_stages(tournament_id,name,stage_type,sequence_number,status)
   values(p_tournament_id,'Group Stage','group',1,'active') returning id into v_stage;
   for v_i in 1..v_groups loop
     insert into public.tournament_groups(stage_id,name,sequence_number)
     values(v_stage,chr(64+v_i),v_i) returning id into v_group;
   end loop;
   -- Snake-free balanced assignment by seed/order, distributed cyclically among groups.
   v_i:=0;
   for v_part in
     select id,seed from public.tournament_participants
     where tournament_id=p_tournament_id and status='confirmed'
     order by coalesce(seed,2147483647),registered_at,id
   loop
     v_i:=v_i+1;
     select id into v_group from public.tournament_groups
     where stage_id=v_stage and sequence_number=((v_i-1)%v_groups)+1;
     insert into public.tournament_stage_entries(stage_id,participant_id,group_id,seed)
     values(v_stage,v_part.id,v_group,coalesce(v_part.seed,v_i));
   end loop;
   insert into public.tournament_stages(tournament_id,name,stage_type,sequence_number,status,settings_json)
   values(p_tournament_id,'Knockout Stage','knockout',2,'pending',jsonb_build_object('source_stage_id',v_stage,'qualifiers_per_group',2))
   returning id into v_ko;
   v_result:=jsonb_build_object('format','group_knockout','group_stage_id',v_stage,'knockout_stage_id',v_ko,'groups',v_groups,'note','Group stage entrants assigned. Qualifiers must be selected and added to the knockout stage after group results.');
 end if;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,details_json)
 values(p_tournament_id,auth.uid(),'default_stages_created','tournament',p_tournament_id::text,v_result);
 return v_result;
end $$;

-- Security-definer tournament RPCs must never be callable by anonymous visitors.
revoke all on function public.tournament_is_admin() from public,anon;
revoke all on function public.tournament_is_participant(uuid) from public,anon;
revoke all on function public.tournament_can_view(uuid) from public,anon;
revoke all on function public.tournament_admin_add_entrant(uuid,text,text,uuid,uuid,integer) from public,anon;
revoke all on function public.tournament_admin_create_stage(uuid,text,text,integer) from public,anon;
revoke all on function public.tournament_submit_result(uuid,integer,integer,text) from public,anon;
revoke all on function public.tournament_review_result(uuid,text,text) from public,anon;
revoke all on function public.tournament_confirm_result(uuid,boolean,text) from public,anon;
revoke all on function public.tournament_register_individual(uuid) from public,anon;
revoke all on function public.tournament_register_team(uuid,text) from public,anon;
revoke all on function public.tournament_team_add_member(uuid,uuid,uuid,text) from public,anon;
revoke all on function public.tournament_admin_review_registration(uuid,text,text) from public,anon;
revoke all on function public.tournament_admin_generate_round(uuid,integer,boolean,text) from public,anon;
revoke all on function public.tournament_standings_for_stage(uuid) from public,anon;
revoke all on function public.tournament_admin_enter_result(uuid,integer,integer,text) from public,anon;
revoke all on function public.tournament_admin_setup_stages(uuid,integer) from public,anon;

grant execute on function public.tournament_is_admin() to authenticated;
grant execute on function public.tournament_is_participant(uuid) to authenticated;
grant execute on function public.tournament_can_view(uuid) to authenticated;
grant execute on function public.tournament_admin_add_entrant(uuid,text,text,uuid,uuid,integer) to authenticated;
grant execute on function public.tournament_admin_create_stage(uuid,text,text,integer) to authenticated;
grant execute on function public.tournament_submit_result(uuid,integer,integer,text) to authenticated;
grant execute on function public.tournament_review_result(uuid,text,text) to authenticated;
grant execute on function public.tournament_confirm_result(uuid,boolean,text) to authenticated;
grant execute on function public.tournament_register_individual(uuid) to authenticated;
grant execute on function public.tournament_register_team(uuid,text) to authenticated;
grant execute on function public.tournament_team_add_member(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.tournament_admin_review_registration(uuid,text,text) to authenticated;
grant execute on function public.tournament_admin_generate_round(uuid,integer,boolean,text) to authenticated;
grant execute on function public.tournament_standings_for_stage(uuid) to authenticated;
grant execute on function public.tournament_admin_enter_result(uuid,integer,integer,text) to authenticated;
grant execute on function public.tournament_admin_setup_stages(uuid,integer) to authenticated;

-- Match results and review/audit rows must only be written through guarded RPCs.
revoke insert,update,delete on public.tournament_matches from authenticated;
revoke insert,update,delete on public.tournament_result_submissions from authenticated;
revoke insert,update,delete on public.tournament_result_reviews from authenticated;
