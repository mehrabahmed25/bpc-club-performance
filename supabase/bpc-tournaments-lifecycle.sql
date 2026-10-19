-- Ending and archiving tournaments.
-- Ended (completed / archived / cancelled) tournaments keep all their records but
-- no longer accept new fixtures or participant-submitted scores, and their
-- unplayed matches stop appearing on player dashboards. Safe to re-run.

-- 1. Admin: end, archive, or restore a tournament -----------------------------
--    'completed' ends it (history stays visible, no new scores).
--    'archived'  tucks it away from the main list (history stays visible).
--    Restoring an archived tournament returns it to 'completed'.
create or replace function public.tournament_admin_set_status(
  p_tournament_id uuid,
  p_status text,
  p_reason text default null
) returns text
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_t public.tournament_tournaments%rowtype; v_open integer; v_pending integer;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if p_status not in ('completed','archived') then raise exception 'A tournament can only be ended (completed) or archived here'; end if;
  select * into v_t from public.tournament_tournaments where id=p_tournament_id for update;
  if not found then raise exception 'Tournament not found'; end if;
  if v_t.status=p_status then raise exception 'This tournament is already %', p_status; end if;
  if p_status='completed' and v_t.status in ('draft','cancelled') then
    raise exception 'A % tournament cannot be ended', v_t.status;
  end if;
  select count(*) filter (where m.status in ('scheduled','rejected','postponed')),
         count(*) filter (where m.status in ('pending_result','pending_confirmation','disputed'))
    into v_open, v_pending
    from public.tournament_matches m where m.tournament_id=p_tournament_id;
  update public.tournament_tournaments set status=p_status, updated_at=now() where id=p_tournament_id;
  insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason,details_json)
  values (p_tournament_id,auth.uid(),
          case when p_status='archived' then 'tournament_archived'
               when v_t.status='archived' then 'tournament_restored'
               else 'tournament_ended' end,
          'tournament',p_tournament_id::text,p_reason,
          jsonb_build_object('previous_status',v_t.status,'unplayed_matches',v_open,'results_awaiting_review',v_pending));
  return p_status;
end $$;
revoke all on function public.tournament_admin_set_status(uuid,text,text) from public,anon;
grant execute on function public.tournament_admin_set_status(uuid,text,text) to authenticated;

-- 2. No new fixtures for an ended tournament -----------------------------------
create or replace function public.tournament_matches_block_ended()
returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_status text;
begin
  select status into v_status from public.tournament_tournaments where id=new.tournament_id;
  if v_status in ('completed','archived','cancelled') then
    raise exception 'This tournament has ended; restore it before creating fixtures';
  end if;
  return new;
end $$;
create or replace trigger tournament_matches_block_ended_trg
  before insert on public.tournament_matches
  for each row execute function public.tournament_matches_block_ended();

-- 3. Participant score submission is closed once a tournament has ended --------
create or replace function public.tournament_submit_result(
  p_match_id uuid, p_score_a integer, p_score_b integer, p_note text default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_m public.tournament_matches%rowtype; v_t public.tournament_tournaments%rowtype; v_submission uuid; v_ok boolean;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if p_score_a<0 or p_score_b<0 then raise exception 'Scores must be non-negative'; end if;
 select * into v_m from public.tournament_matches where id=p_match_id for update;
 if not found then raise exception 'Match not found'; end if;
 select * into v_t from public.tournament_tournaments where id=v_m.tournament_id;
 if v_t.status in ('completed','archived','cancelled') then raise exception 'This tournament has ended and is no longer accepting scores'; end if;
 if v_t.score_workflow='admin_entered' then raise exception 'This tournament accepts results from admins only'; end if;
 if v_m.status not in ('scheduled','rejected') then raise exception 'Match is not accepting a score'; end if;
 if v_m.deadline_at is not null and now()>v_m.deadline_at then
   raise exception 'The deadline for this match has passed. Please contact an administrator.';
 end if;
 select exists(select 1 from public.tournament_participants p where p.id in (v_m.participant_a_id,v_m.participant_b_id) and p.user_id=auth.uid() and p.status='confirmed')
 or exists(select 1 from public.tournament_teams tt join public.tournament_team_members tm on tm.team_id=tt.id where tt.participant_id in (v_m.participant_a_id,v_m.participant_b_id) and tm.user_id=auth.uid() and tm.status='active') into v_ok;
 if not v_ok then raise exception 'Only a participant in this match can submit a score'; end if;
 insert into public.tournament_result_submissions(match_id,submitted_by,score_a,score_b,note,status)
 values(v_m.id,auth.uid(),p_score_a,p_score_b,p_note,case when v_t.score_workflow='participant_opponent_admin' then 'awaiting_opponent' else 'pending' end) returning id into v_submission;
 update public.tournament_matches set status=case when v_t.score_workflow='participant_opponent_admin' then 'pending_confirmation' else 'pending_result' end,submitted_by=auth.uid(),submitted_at=now(),updated_at=now() where id=v_m.id;
 return v_submission;
end $$;

-- 4. Dashboard feed: unplayed matches of ended tournaments disappear; results stay
create or replace function public.tournament_my_matches()
returns table(
  match_id uuid, tournament_id uuid, tournament_name text, stage_name text, stage_type text,
  group_name text, round_number integer, match_number integer, status text,
  deadline_at timestamptz, my_participant_id uuid, my_name text, opponent_name text,
  my_score integer, opponent_score integer, outcome text, approved_at timestamptz,
  can_submit boolean, note text
)
language sql stable security definer set search_path=public,pg_temp
as $$
  with mine as (
    select p.id from public.tournament_participants p
     where auth.uid() is not null and p.status='confirmed'
       and (p.user_id=auth.uid()
            or exists (select 1 from public.tournament_teams tt
                         join public.tournament_team_members tm on tm.team_id=tt.id
                        where tt.participant_id=p.id and tm.user_id=auth.uid() and tm.status='active'))
  ), base as (
    select m.*, me.id as me_id,
           case when m.participant_a_id=me.id then m.participant_b_id else m.participant_a_id end as opp_id
      from public.tournament_matches m
      join mine me on me.id in (m.participant_a_id, m.participant_b_id)
     where m.status<>'cancelled'
  )
  select b.id, t.id, t.name, s.name, s.stage_type, g.name, b.round_number, b.match_number, b.status,
         b.deadline_at, b.me_id,
         public.tournament_entrant_name(b.me_id),
         case when b.opp_id is null then null else public.tournament_entrant_name(b.opp_id) end,
         case when b.status in ('approved','completed') then (case when b.participant_a_id=b.me_id then b.score_a else b.score_b end) end,
         case when b.status in ('approved','completed') then (case when b.participant_a_id=b.me_id then b.score_b else b.score_a end) end,
         case when b.status='bye' then 'bye'
              when b.status in ('approved','completed') then
                (case when b.winner_participant_id=b.me_id then 'win'
                      when b.winner_participant_id is null and b.score_a=b.score_b then 'draw'
                      else 'loss' end) end,
         b.approved_at,
         (t.score_workflow<>'admin_entered' and t.status not in ('completed','archived','cancelled')
            and b.status in ('scheduled','rejected')
            and b.participant_a_id is not null and b.participant_b_id is not null
            and (b.deadline_at is null or b.deadline_at>now())),
         case b.status
           when 'pending_result' then 'Score submitted, awaiting admin approval'
           when 'pending_confirmation' then
             (case when (select rs.submitted_by from public.tournament_result_submissions rs
                          where rs.match_id=b.id order by rs.created_at desc limit 1)=auth.uid()
                   then 'Score submitted, awaiting opponent confirmation'
                   else 'Your opponent submitted a score, please confirm it on the tournament page' end)
           when 'disputed' then 'Score under admin review'
           when 'rejected' then 'Score was rejected, please submit again'
           else null end
    from base b
    join public.tournament_tournaments t on t.id=b.tournament_id and t.status<>'draft'
    join public.tournament_stages s on s.id=b.stage_id
    left join public.tournament_groups g on g.id=b.group_id
   where t.status not in ('completed','archived','cancelled') or b.status in ('approved','completed')
   order by b.deadline_at nulls last, b.round_number, b.match_number;
$$;
revoke all on function public.tournament_my_matches() from public,anon;
grant execute on function public.tournament_my_matches() to authenticated;
