-- BPC Tournaments workflow functions (apply after bpc-tournaments-core.sql).
-- This migration only touches tournament_* objects.
create or replace function public.tournament_admin_add_entrant(
 p_tournament_id uuid,p_entrant_type text,p_display_name text,
 p_user_id uuid default null,p_cobeg_member_id uuid default null,p_seed integer default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_type text; v_id uuid;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 select competition_type into v_type from public.tournament_tournaments where id=p_tournament_id for update;
 if not found then raise exception 'Tournament not found'; end if;
 if p_entrant_type<>v_type then raise exception 'Entrant type must match tournament'; end if;
 if num_nonnulls(p_user_id,p_cobeg_member_id,nullif(trim(p_display_name),''))<>1 then raise exception 'Choose exactly one account, member record, or external name'; end if;
 insert into public.tournament_participants(tournament_id,entrant_type,user_id,cobeg_member_id,external_name,registration_source,status,seed,created_by,approved_by,approved_at)
 values(p_tournament_id,p_entrant_type,p_user_id,p_cobeg_member_id,case when p_user_id is null and p_cobeg_member_id is null then trim(p_display_name) end,'admin','confirmed',p_seed,auth.uid(),auth.uid(),now()) returning id into v_id;
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id) values(p_tournament_id,auth.uid(),'entrant_added','participant',v_id::text);
 return v_id;
end $$;

create or replace function public.tournament_admin_create_stage(
 p_tournament_id uuid,p_name text,p_stage_type text,p_sequence integer
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 if p_stage_type not in ('round_robin','knockout','group','swiss') then raise exception 'Invalid stage type'; end if;
 insert into public.tournament_stages(tournament_id,name,stage_type,sequence_number) values(p_tournament_id,trim(p_name),p_stage_type,p_sequence) returning id into v_id;
 insert into public.tournament_stage_entries(stage_id,participant_id,seed) select v_id,id,seed from public.tournament_participants where tournament_id=p_tournament_id and status='confirmed';
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id) values(p_tournament_id,auth.uid(),'stage_created','stage',v_id::text);
 return v_id;
end $$;

create or replace function public.tournament_submit_result(
 p_match_id uuid,p_score_a integer,p_score_b integer,p_note text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_m public.tournament_matches%rowtype; v_t public.tournament_tournaments%rowtype; v_submission uuid; v_ok boolean;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if p_score_a<0 or p_score_b<0 then raise exception 'Scores must be non-negative'; end if;
 select * into v_m from public.tournament_matches where id=p_match_id for update;
 if not found then raise exception 'Match not found'; end if;
 select * into v_t from public.tournament_tournaments where id=v_m.tournament_id;
 if v_t.score_workflow='admin_entered' then raise exception 'This tournament accepts results from admins only'; end if;
 if v_m.status not in ('scheduled','rejected') then raise exception 'Match is not accepting a score'; end if;
 select exists(select 1 from public.tournament_participants p where p.id in (v_m.participant_a_id,v_m.participant_b_id) and p.user_id=auth.uid() and p.status='confirmed')
 or exists(select 1 from public.tournament_teams tt join public.tournament_team_members tm on tm.team_id=tt.id where tt.participant_id in (v_m.participant_a_id,v_m.participant_b_id) and tm.user_id=auth.uid() and tm.status='active') into v_ok;
 if not v_ok then raise exception 'Only a participant in this match can submit a score'; end if;
 insert into public.tournament_result_submissions(match_id,submitted_by,score_a,score_b,note,status)
 values(v_m.id,auth.uid(),p_score_a,p_score_b,p_note,case when v_t.score_workflow='participant_opponent_admin' then 'awaiting_opponent' else 'pending' end) returning id into v_submission;
 update public.tournament_matches set status=case when v_t.score_workflow='participant_opponent_admin' then 'pending_confirmation' else 'pending_result' end,submitted_by=auth.uid(),submitted_at=now(),updated_at=now() where id=v_m.id;
 return v_submission;
end $$;

create or replace function public.tournament_review_result(p_submission_id uuid,p_decision text,p_reason text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_s public.tournament_result_submissions%rowtype; v_m public.tournament_matches%rowtype; v_t public.tournament_tournaments%rowtype; v_winner uuid;
begin
 if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
 if p_decision not in ('approve','reject','dispute') then raise exception 'Decision must be approve, reject, or dispute'; end if;
 select * into v_s from public.tournament_result_submissions where id=p_submission_id for update;
 if not found or v_s.status not in ('pending','disputed') then raise exception 'Submission is not reviewable'; end if;
 select * into v_m from public.tournament_matches where id=v_s.match_id for update;
 select * into v_t from public.tournament_tournaments where id=v_m.tournament_id;
 if p_decision='approve' then
  if v_t.score_workflow='participant_opponent_admin' and v_s.opponent_confirmed_at is null then raise exception 'Opponent confirmation is required'; end if;
  if v_s.score_a>v_s.score_b then v_winner:=v_m.participant_a_id; elsif v_s.score_b>v_s.score_a then v_winner:=v_m.participant_b_id; else v_winner:=null; end if;
  update public.tournament_result_submissions set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),review_reason=p_reason where id=v_s.id;
  update public.tournament_matches set score_a=v_s.score_a,score_b=v_s.score_b,winner_participant_id=v_winner,status='approved',approved_by=auth.uid(),approved_at=now(),result_version=result_version+1,updated_at=now() where id=v_m.id;
 else
  update public.tournament_result_submissions set status=case when p_decision='reject' then 'rejected' else 'disputed' end,reviewed_by=auth.uid(),reviewed_at=now(),review_reason=p_reason where id=v_s.id;
  update public.tournament_matches set status=case when p_decision='reject' then 'rejected' else 'disputed' end,updated_at=now() where id=v_m.id;
 end if;
 insert into public.tournament_result_reviews(submission_id,action,actor_user_id,reason) values(v_s.id,case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'disputed' end,auth.uid(),p_reason);
 insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason) values(v_m.tournament_id,auth.uid(),'result_'||p_decision,'match',v_m.id::text,p_reason);
 return v_m.id;
end $$;

create or replace function public.tournament_confirm_result(p_submission_id uuid,p_confirm boolean,p_reason text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_s public.tournament_result_submissions%rowtype; v_m public.tournament_matches%rowtype; v_t public.tournament_tournaments%rowtype; v_ok boolean;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 select * into v_s from public.tournament_result_submissions where id=p_submission_id for update;
 if not found or v_s.status<>'awaiting_opponent' then raise exception 'Submission is not awaiting confirmation'; end if;
 select * into v_m from public.tournament_matches where id=v_s.match_id for update;
 select * into v_t from public.tournament_tournaments where id=v_m.tournament_id;
 if v_t.score_workflow<>'participant_opponent_admin' then raise exception 'Opponent confirmation is not configured'; end if;
 if v_s.submitted_by=auth.uid() then raise exception 'Submitter cannot confirm their own result'; end if;
 select exists(select 1 from public.tournament_participants p where p.id in (v_m.participant_a_id,v_m.participant_b_id) and p.user_id=auth.uid() and p.user_id<>v_s.submitted_by and p.status='confirmed')
 or exists(select 1 from public.tournament_teams tt join public.tournament_team_members tm on tm.team_id=tt.id where tt.participant_id in (v_m.participant_a_id,v_m.participant_b_id) and tm.user_id=auth.uid() and tm.user_id<>v_s.submitted_by and tm.status='active') into v_ok;
 if not v_ok then raise exception 'Only the opposing entrant may confirm'; end if;
 if p_confirm then
  update public.tournament_result_submissions set status='pending',opponent_confirmed_by=auth.uid(),opponent_confirmed_at=now() where id=v_s.id;
  update public.tournament_matches set status='pending_result',updated_at=now() where id=v_m.id;
  insert into public.tournament_result_reviews(submission_id,action,actor_user_id,reason) values(v_s.id,'confirmed',auth.uid(),p_reason);
 else
  update public.tournament_result_submissions set status='disputed',review_reason=p_reason where id=v_s.id;
  update public.tournament_matches set status='disputed',updated_at=now() where id=v_m.id;
  insert into public.tournament_result_reviews(submission_id,action,actor_user_id,reason) values(v_s.id,'disputed',auth.uid(),p_reason);
 end if;
 return v_s.id;
end $$;

grant execute on function public.tournament_admin_add_entrant(uuid,text,text,uuid,uuid,integer) to authenticated;
grant execute on function public.tournament_admin_create_stage(uuid,text,text,integer) to authenticated;
grant execute on function public.tournament_submit_result(uuid,integer,integer,text) to authenticated;
grant execute on function public.tournament_review_result(uuid,text,text) to authenticated;
grant execute on function public.tournament_confirm_result(uuid,boolean,text) to authenticated;
revoke insert,update,delete on public.tournament_matches from authenticated;
revoke insert,update,delete on public.tournament_result_submissions from authenticated;
revoke insert,update,delete on public.tournament_result_reviews from authenticated;
