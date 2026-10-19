-- Fixtures with real participants, admin-set deadlines, and per-player match feed.
-- Safe to re-run.

-- 1. Deadline column --------------------------------------------------------
alter table public.tournament_matches add column if not exists deadline_at timestamptz;
create index if not exists tournament_matches_deadline_idx
  on public.tournament_matches(deadline_at) where deadline_at is not null;

-- 2. Generate round: keep the original algorithm as an internal "core" function,
--    and wrap it so that (a) the stage's entrant list is synced with the currently
--    confirmed participants before round 1 and (b) an admin deadline can be applied.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='tournament_admin_generate_round'
      and pg_get_function_identity_arguments(p.oid)='p_stage_id uuid, p_round integer, p_publish boolean, p_reason text'
  ) then
    alter function public.tournament_admin_generate_round(uuid,integer,boolean,text)
      rename to tournament_admin_generate_round_core;
  end if;
end $$;
revoke all on function public.tournament_admin_generate_round_core(uuid,integer,boolean,text) from public,anon,authenticated;

create or replace function public.tournament_admin_generate_round(
  p_stage_id uuid,
  p_round integer,
  p_publish boolean default false,
  p_reason text default null,
  p_deadline timestamptz default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  v_s public.tournament_stages%rowtype;
  v_run uuid;
  v_gid uuid;
  v_count integer;
  r record;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if p_deadline is not null and p_deadline <= now() then raise exception 'The deadline must be in the future'; end if;
  select * into v_s from public.tournament_stages where id=p_stage_id for update;
  if not found then raise exception 'Stage not found'; end if;

  -- Before the first fixtures of a stage exist, line the entrant list up with the
  -- participants who are confirmed right now (stages created by hand, or players
  -- confirmed/removed after the stage was set up). Knockout stages fed by a group
  -- stage are filled by the qualifier step instead.
  if not exists (select 1 from public.tournament_matches where stage_id=p_stage_id)
     and not (v_s.stage_type='knockout' and v_s.settings_json ? 'source_stage_id') then
    update public.tournament_stage_entries se set entry_status='withdrawn'
      from public.tournament_participants p
     where se.stage_id=p_stage_id and p.id=se.participant_id
       and p.status<>'confirmed' and se.entry_status in ('active','qualified');
    update public.tournament_stage_entries se set entry_status='active'
      from public.tournament_participants p
     where se.stage_id=p_stage_id and p.id=se.participant_id
       and p.status='confirmed' and se.entry_status='withdrawn';
    for r in
      select p.id, p.seed from public.tournament_participants p
       where p.tournament_id=v_s.tournament_id and p.status='confirmed'
         and not exists (select 1 from public.tournament_stage_entries se where se.stage_id=p_stage_id and se.participant_id=p.id)
       order by coalesce(p.seed,2147483647), p.registered_at, p.id
    loop
      v_gid := null;
      if v_s.stage_type='group' then
        select g.id into v_gid from public.tournament_groups g
         where g.stage_id=p_stage_id
         order by (select count(*) from public.tournament_stage_entries se
                    where se.group_id=g.id and se.entry_status in ('active','qualified')), g.sequence_number
         limit 1;
        if v_gid is null then continue; end if;
      end if;
      insert into public.tournament_stage_entries(stage_id,participant_id,group_id,seed)
      values (p_stage_id, r.id, v_gid, r.seed);
    end loop;
  end if;

  v_run := public.tournament_admin_generate_round_core(p_stage_id,p_round,p_publish,p_reason);

  if p_deadline is not null then
    update public.tournament_matches set deadline_at=p_deadline
     where pairing_run_id=v_run and status='scheduled';
    get diagnostics v_count = row_count;
    insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,reason,details_json)
    values (v_s.tournament_id,auth.uid(),'round_deadline_set','stage',p_stage_id::text,p_reason,
            jsonb_build_object('round',p_round,'deadline_at',p_deadline,'matches',v_count));
  end if;
  return v_run;
end $$;
revoke all on function public.tournament_admin_generate_round(uuid,integer,boolean,text,timestamptz) from public,anon;
grant execute on function public.tournament_admin_generate_round(uuid,integer,boolean,text,timestamptz) to authenticated;

-- 3. Change (or clear) the deadline of an existing round ----------------------
create or replace function public.tournament_admin_set_round_deadline(
  p_stage_id uuid,
  p_round integer,
  p_deadline timestamptz
) returns integer
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_tid uuid; v_count integer;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  if p_deadline is not null and p_deadline <= now() then raise exception 'The deadline must be in the future'; end if;
  select tournament_id into v_tid from public.tournament_stages where id=p_stage_id;
  if not found then raise exception 'Stage not found'; end if;
  update public.tournament_matches set deadline_at=p_deadline, updated_at=now()
   where stage_id=p_stage_id and round_number=p_round and status in ('scheduled','rejected');
  get diagnostics v_count = row_count;
  if v_count=0 then raise exception 'This round has no open matches to update'; end if;
  insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,details_json)
  values (v_tid,auth.uid(),'round_deadline_set','stage',p_stage_id::text,
          jsonb_build_object('round',p_round,'deadline_at',p_deadline,'matches',v_count));
  return v_count;
end $$;
revoke all on function public.tournament_admin_set_round_deadline(uuid,integer,timestamptz) from public,anon;
grant execute on function public.tournament_admin_set_round_deadline(uuid,integer,timestamptz) to authenticated;

-- 4. Participant score submission now honours the deadline --------------------
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

-- 5. Entrant display name (internal helper) -----------------------------------
create or replace function public.tournament_entrant_name(p_participant_id uuid)
returns text
language sql stable security definer set search_path=public,pg_temp
as $$
  select coalesce(
    nullif(trim(p.external_name),''),
    (select tt.team_name from public.tournament_teams tt where tt.participant_id=p.id),
    (select pl.display_name from public.players pl where pl.user_id=p.user_id),
    (select pr.display_name from public.profiles pr where pr.id=p.user_id),
    (select cm.name from public.cobeg_members cm where cm.id=p.cobeg_member_id),
    'Entrant')
  from public.tournament_participants p where p.id=p_participant_id;
$$;
revoke all on function public.tournament_entrant_name(uuid) from public,anon,authenticated;

-- 6. The signed-in player's own tournament matches (dashboard feed) -----------
-- Scores and outcomes are returned only once a result is approved.
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
         (t.score_workflow<>'admin_entered' and b.status in ('scheduled','rejected')
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
   order by b.deadline_at nulls last, b.round_number, b.match_number;
$$;
revoke all on function public.tournament_my_matches() from public,anon;
grant execute on function public.tournament_my_matches() to authenticated;
