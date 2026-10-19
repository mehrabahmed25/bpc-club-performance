-- Permanently delete an ARCHIVED tournament (for test tournaments). Full admins only.
-- The tournament name must be typed to confirm. Players, stages, fixtures, scores and
-- announcements of that tournament are removed; a 'tournament_deleted' audit entry stays.
-- Safe to re-run.
create or replace function public.tournament_admin_delete(p_tournament_id uuid, p_confirm_name text)
returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_t public.tournament_tournaments%rowtype; v_players integer; v_matches integer; v_stages integer;
begin
  if not public.tournament_is_full_admin() then raise exception 'Only a full administrator can delete a tournament'; end if;
  select * into v_t from public.tournament_tournaments where id=p_tournament_id for update;
  if not found then raise exception 'Tournament not found'; end if;
  if v_t.status<>'archived' then raise exception 'Archive the tournament first. Only archived tournaments can be deleted'; end if;
  if lower(trim(coalesce(p_confirm_name,'')))<>lower(trim(v_t.name)) then raise exception 'The name you typed does not match this tournament'; end if;
  select count(*) into v_players from public.tournament_participants where tournament_id=p_tournament_id;
  select count(*) into v_matches from public.tournament_matches where tournament_id=p_tournament_id;
  select count(*) into v_stages from public.tournament_stages where tournament_id=p_tournament_id;
  -- Matches first: they reference participants with RESTRICT, so they must go before the cascade.
  delete from public.tournament_matches where tournament_id=p_tournament_id;
  delete from public.tournament_tournaments where id=p_tournament_id;
  insert into public.tournament_audit_logs(tournament_id,actor_user_id,action,entity_type,entity_id,details_json)
  values (null,auth.uid(),'tournament_deleted','tournament',p_tournament_id::text,
          jsonb_build_object('name',v_t.name,'format',v_t.format,'participants',v_players,'matches',v_matches,'stages',v_stages));
  return jsonb_build_object('name',v_t.name,'participants',v_players,'matches',v_matches);
end $$;
revoke all on function public.tournament_admin_delete(uuid,text) from public,anon;
grant execute on function public.tournament_admin_delete(uuid,text) to authenticated;
