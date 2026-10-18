-- Add an audited admin-entered score path without granting direct table writes.
create or replace function public.tournament_admin_enter_result(
 p_match_id uuid,p_score_a integer,p_score_b integer,p_reason text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_m public.tournament_matches%rowtype; v_t public.tournament_tournaments%rowtype; v_id uuid; v_winner uuid;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 if p_score_a<0 or p_score_b<0 then raise exception 'Scores must be non-negative'; end if;
 select * into v_m from public.tournament_matches where id=p_match_id for update;
 if not found then raise exception 'Match not found'; end if;
 select * into v_t from public.tournament_tournaments where id=v_m.tournament_id;
 if v_t.score_workflow<>'admin_entered' then raise exception 'This tournament is configured for participant-submitted scores'; end if;
 if v_m.participant_a_id is null or v_m.participant_b_id is null or v_m.status not in ('scheduled','rejected') then raise exception 'Match cannot accept an admin-entered score'; end if;
 if p_score_a>p_score_b then v_winner:=v_m.participant_a_id; elsif p_score_b>p_score_a then v_winner:=v_m.participant_b_id; else v_winner:=null; end if;
 insert into public.tournament_result_submissions(match_id,submitted_by,score_a,score_b,note,status,reviewed_by,reviewed_at,review_reason)
 values(v_m.id,auth.uid(),p_score_a,p_score_b,p_reason,'approved',auth.uid(),now(),p_reason) returning id into v_id;
 update public.tournament_matches set score_a=p_score_a,score_b=p_score_b,winner_participant_id=v_winner,status='approved',submitted_by=auth.uid(),submitted_at=now(),approved_by=auth.uid(),approved_at=now(),result_version=result_version+1,updated_at=now() where id=v_m.id;
 insert into public.tournament_result_reviews(submission_id,action,actor_user_id,reason) values(v_id,'approved',auth.uid(),p_reason);
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason)
 values(v_m.tournament_id,auth.uid(),'admin_entered_result','match',v_m.id::text,p_reason);
 return v_id;
end $$;
revoke all on function public.tournament_admin_enter_result(uuid,integer,integer,text) from public,anon;
grant execute on function public.tournament_admin_enter_result(uuid,integer,integer,text) to authenticated;
