-- Profile pictures: tiny JPEGs (<=50 KB, client shrinks to 192px) in the public "avatars" bucket.
alter table public.players add column if not exists avatar_updated_at timestamptz;
create or replace view public.player_avatars as
  select id, user_id, display_name, avatar_updated_at from public.players
  where active = true and avatar_updated_at is not null;
grant select on public.player_avatars to anon, authenticated;
create or replace function public.set_my_avatar(p_set boolean)
returns timestamptz language plpgsql security definer set search_path=public,pg_temp
as $$
declare v timestamptz;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  update public.players set avatar_updated_at = case when p_set then now() else null end
   where user_id=auth.uid() and active=true returning avatar_updated_at into v;
  if not found then raise exception 'Your player profile is inactive or missing.'; end if;
  return v;
end $$;
revoke all on function public.set_my_avatar(boolean) from public,anon;
grant execute on function public.set_my_avatar(boolean) to authenticated;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('avatars','avatars',true,51200,array['image/jpeg','image/webp'])
on conflict (id) do update set public=true, file_size_limit=51200, allowed_mime_types=array['image/jpeg','image/webp'];
create policy "Users upload own avatar" on storage.objects for insert to authenticated with check (bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Users update own avatar" on storage.objects for update to authenticated using (bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text) with check (bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Users delete own avatar" on storage.objects for delete to authenticated using (bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
