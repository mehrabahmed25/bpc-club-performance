-- Soft-remove players: hidden from the live site, all data kept, restorable.
alter table public.players add column if not exists removed_at timestamptz, add column if not exists removed_by uuid;

create or replace function public.admin_remove_player(p_player_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select user_id into v_user from public.players where id=p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  if v_user = auth.uid() then raise exception 'You cannot remove your own account.'; end if;
  update public.players set active=false, removed_at=now(), removed_by=auth.uid() where id=p_player_id;
  return true;
end $$;

create or replace function public.admin_restore_player(p_player_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  update public.players set active=true, removed_at=null, removed_by=null where id=p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  return true;
end $$;

revoke all on function public.admin_remove_player(uuid) from public,anon;
revoke all on function public.admin_restore_player(uuid) from public,anon;
grant execute on function public.admin_remove_player(uuid) to authenticated;
grant execute on function public.admin_restore_player(uuid) to authenticated;
