-- BPC Tournaments self-registration policy patch.
-- Apply after bpc-tournaments-core.sql. Additive and limited to tournament tables.

drop policy if exists tournament_participants_self_register on public.tournament_participants;
create policy tournament_participants_self_register
on public.tournament_participants for insert to authenticated
with check (
  user_id = auth.uid()
  and entrant_type = 'individual'
  and cobeg_member_id is null
  and external_name is null
  and registration_source = 'self'
  and created_by = auth.uid()
  and exists (
    select 1
    from public.tournament_tournaments t
    where t.id = tournament_id
      and t.competition_type = 'individual'
      and t.status = 'registration_open'
      and t.registration_mode in ('self','both')
      and (t.registration_deadline is null or t.registration_deadline > now())
      and (t.registration_requires_approval and status = 'pending'
           or not t.registration_requires_approval and status = 'confirmed')
      and (
        t.participant_limit is null
        or (select count(*) from public.tournament_participants p
            where p.tournament_id = t.id
              and p.status in ('pending','confirmed','waitlisted')) < t.participant_limit
      )
  )
);

-- Admin-managed entrant additions remain restricted to tournament admins.
-- Team creation/registration is intentionally admin-managed until a dedicated
-- transactional team registration flow is implemented and tested.
