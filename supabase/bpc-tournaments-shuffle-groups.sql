-- Random group draw for a group stage. Allowed only before any fixtures exist.
-- Safe to re-run.
create or replace function public.tournament_admin_shuffle_groups(p_stage_id uuid)
returns integer
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_s public.tournament_stages%rowtype; v_status text; v_groups integer; v_i integer:=0; r record; v_gid uuid;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into v_s from public.tournament_stages where id=p_stage_id for update;
  if not found then raise exception 'Stage not found'; end if;
  if v_s.stage_type<>'group' then raise exception 'Only a group stage can be drawn into groups'; end if;
  select status into v_status from public.tournament_tournaments where id=v_s.tournament_id;
  if v_status in ('completed','archived','cancelled') then raise exception 'This tournament has ended'; end if;
  if exists(select 1 from public.tournament_matches where stage_id=p_stage_id and status<>'cancelled') then
    raise exception 'Groups are locked once fixtures have been generated';
  end if;
  select count(*) into v_groups from public.tournament_groups where stage_id=p_stage_id;
  if v_groups=0 then raise exception 'This stage has no groups'; end if;
  for r in
    select se.id from public.tournament_stage_entries se
      join public.tournament_participants p on p.id=se.participant_id
     where se.stage_id=p_stage_id and se.entry_status in ('active','qualified') and p.status='confirmed'
     order by random()
  loop
    v_i:=v_i+1;
    select id into v_gid from public.tournament_groups where stage_id=p_stage_id and sequence_number=((v_i-1)%v_groups)+1;
    update public.tournament_stage_entries set group_id=v_gid where id=r.id;
  end loop;
  insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,details_json)
  values (v_s.tournament_id,auth.uid(),'groups_drawn_randomly','stage',p_stage_id::text,jsonb_build_object('entrants',v_i,'groups',v_groups));
  return v_i;
end $$;
revoke all on function public.tournament_admin_shuffle_groups(uuid) from public,anon;
grant execute on function public.tournament_admin_shuffle_groups(uuid) to authenticated;
