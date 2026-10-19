-- Admin controls for tournament participant approval and removal.
-- Removal is a soft withdrawal so audit/history remains intact.
create or replace function public.tournament_admin_remove_participant(
 p_participant_id uuid,
 p_reason text default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_p public.tournament_participants%rowtype;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 select * into v_p from public.tournament_participants where id=p_participant_id for update;
 if not found then raise exception 'Participant not found'; end if;
 if v_p.status='withdrawn' then raise exception 'Participant is already removed'; end if;
 if exists(select 1 from public.tournament_matches m where m.tournament_id=v_p.tournament_id and (m.participant_a_id=v_p.id or m.participant_b_id=v_p.id) and m.status in ('approved','completed')) then
   raise exception 'Cannot remove an entrant with completed matches. Disqualify them or resolve their tournament history instead.';
 end if;
 update public.tournament_participants set status='withdrawn' where id=v_p.id;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason)
 values(v_p.tournament_id,auth.uid(),'participant_removed','participant',v_p.id::text,p_reason);
 return v_p.id;
end $$;
revoke all on function public.tournament_admin_remove_participant(uuid,text) from public,anon;
grant execute on function public.tournament_admin_remove_participant(uuid,text) to authenticated;
