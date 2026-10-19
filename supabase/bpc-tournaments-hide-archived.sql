-- Hide archived (e.g. test) tournaments from the Archived list. Nothing is deleted.
-- Hidden tournaments can be shown again with "Show hidden". Safe to re-run.
alter table public.tournament_tournaments add column if not exists hidden_at timestamptz;

create or replace function public.tournament_admin_set_hidden(p_tournament_id uuid, p_hidden boolean)
returns boolean
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_t public.tournament_tournaments%rowtype;
begin
  if not public.tournament_is_admin() then raise exception 'Administrator permission required'; end if;
  select * into v_t from public.tournament_tournaments where id=p_tournament_id for update;
  if not found then raise exception 'Tournament not found'; end if;
  if p_hidden and v_t.status<>'archived' then raise exception 'Only archived tournaments can be hidden'; end if;
  update public.tournament_tournaments set hidden_at=case when p_hidden then now() else null end where id=p_tournament_id;
  insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,details_json)
  values (p_tournament_id,auth.uid(),case when p_hidden then 'tournament_hidden' else 'tournament_unhidden' end,'tournament',p_tournament_id::text,'{}'::jsonb);
  return p_hidden;
end $$;
revoke all on function public.tournament_admin_set_hidden(uuid,boolean) from public,anon;
grant execute on function public.tournament_admin_set_hidden(uuid,boolean) to authenticated;
