-- Tournament managers + archived tournaments hidden from players.
-- * A "tournament manager" is a registered account a full admin has granted access to
--   manage tournaments only (create, fixtures, approvals, end/archive). It carries no
--   other admin power (funds, branding, official matches stay full-admin only).
-- * Only full admins can grant or revoke manager access.
-- * Archived tournaments are visible to admins and managers only.
-- Safe to re-run.

create table if not exists public.tournament_managers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);
alter table public.tournament_managers enable row level security;

create or replace function public.tournament_is_full_admin()
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$ select exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'); $$;
revoke all on function public.tournament_is_full_admin() from public,anon;
grant execute on function public.tournament_is_full_admin() to authenticated;

-- Existing tournament policies and RPCs call tournament_is_admin(); managers now pass it too.
create or replace function public.tournament_is_admin()
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$ select public.tournament_is_full_admin()
        or exists(select 1 from public.tournament_managers m where m.user_id=auth.uid()); $$;

-- A manager can read their own row; a full admin reads everything. Writes go through RPCs only.
do $$ begin
  if not exists (select 1 from pg_policies where tablename='tournament_managers' and policyname='tournament_managers_read') then
    create policy tournament_managers_read on public.tournament_managers for select to authenticated
      using (user_id=auth.uid() or public.tournament_is_full_admin());
  end if;
end $$;
revoke all on public.tournament_managers from public,anon;
grant select on public.tournament_managers to authenticated;

create or replace function public.tournament_admin_set_manager(p_user_id uuid, p_grant boolean)
returns boolean
language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if not public.tournament_is_full_admin() then raise exception 'Only a full administrator can manage tournament access'; end if;
  if p_grant then
    if not exists (select 1 from auth.users where id=p_user_id) then raise exception 'Account not found'; end if;
    insert into public.tournament_managers(user_id,granted_by) values (p_user_id,auth.uid()) on conflict (user_id) do nothing;
  else
    delete from public.tournament_managers where user_id=p_user_id;
  end if;
  insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,details_json)
  values (null,auth.uid(),case when p_grant then 'manager_granted' else 'manager_revoked' end,'user',p_user_id::text,'{}'::jsonb);
  return p_grant;
end $$;
revoke all on function public.tournament_admin_set_manager(uuid,boolean) from public,anon;
grant execute on function public.tournament_admin_set_manager(uuid,boolean) to authenticated;

-- Archived tournaments: admins and managers only.
create or replace function public.tournament_can_view(p_tournament_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
 select public.tournament_is_admin() or exists (
   select 1 from public.tournament_tournaments t
   where t.id=p_tournament_id and t.status not in ('draft','archived') and (
     t.visibility='all_members'
     or (t.visibility='participants_admins' and public.tournament_is_participant(t.id))
     or (t.visibility='restricted' and public.tournament_is_participant(t.id))
   )
 );
$$;
alter policy tournament_tournaments_view on public.tournament_tournaments
  using (public.tournament_is_admin() or (status not in ('draft','archived') and (visibility='all_members'
         or (visibility in ('participants_admins','restricted') and public.tournament_is_participant(id)))));

-- Dashboard feed: nothing from archived tournaments
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
   where t.status<>'archived'
     and (t.status not in ('completed','cancelled') or b.status in ('approved','completed'))
   order by b.deadline_at nulls last, b.round_number, b.match_number;
$$;
revoke all on function public.tournament_my_matches() from public,anon;
grant execute on function public.tournament_my_matches() to authenticated;
