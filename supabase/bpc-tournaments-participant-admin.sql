-- Admin controls for tournament participant approval and removal.
-- Approval uses the existing tournament_admin_review_registration(pending -> confirmed).
-- Removal is a soft withdrawal (status = 'withdrawn') so audit/history remains intact.
create or replace function public.tournament_admin_remove_participant(
 p_participant_id uuid,
 p_reason text default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
 v_p public.tournament_participants%rowtype;
 v_open int;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 select * into v_p from public.tournament_participants where id=p_participant_id for update;
 if not found then raise exception 'Participant not found'; end if;
 if v_p.status not in ('pending','confirmed','waitlisted') then
   raise exception 'Only pending, confirmed or waitlisted entrants can be removed (current status: %)', v_p.status;
 end if;
 -- Safeguard: never silently remove an entrant whose matches carry or are producing results.
 if exists(select 1 from public.tournament_matches m
           where m.tournament_id=v_p.tournament_id
             and (m.participant_a_id=v_p.id or m.participant_b_id=v_p.id)
             and m.status in ('approved','completed','pending_result','pending_confirmation','disputed')) then
   raise exception 'Cannot remove an entrant with completed or in-review matches. Disqualify them or resolve their tournament history instead.';
 end if;
 select count(*) into v_open from public.tournament_matches m
  where m.tournament_id=v_p.tournament_id
    and (m.participant_a_id=v_p.id or m.participant_b_id=v_p.id)
    and m.status in ('scheduled','postponed','rejected');
 update public.tournament_participants set status='withdrawn' where id=v_p.id;
 update public.tournament_stage_entries set entry_status='withdrawn'
  where participant_id=v_p.id and entry_status in ('active','qualified');
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason,details_json)
 values(v_p.tournament_id,auth.uid(),'participant_removed','participant',v_p.id::text,p_reason,
        jsonb_build_object('previous_status',v_p.status,'open_fixtures_affected',v_open));
 return v_p.id;
end $$;
revoke all on function public.tournament_admin_remove_participant(uuid,text) from public,anon;
grant execute on function public.tournament_admin_remove_participant(uuid,text) to authenticated;
