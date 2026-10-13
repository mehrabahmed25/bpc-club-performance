create table if not exists public.site_branding (
  id integer primary key check (id = 1),
  club_name text not null default 'Brahmanbaria Pes Club',
  subtitle text not null default 'Official Website',
  logo_path text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.site_branding (id, club_name, subtitle)
values (1, 'Brahmanbaria Pes Club', 'Official Website')
on conflict (id) do nothing;

alter table public.site_branding enable row level security;

drop policy if exists "Public can read site branding" on public.site_branding;
create policy "Public can read site branding"
on public.site_branding for select
to anon, authenticated
using (true);

drop policy if exists "Admins can insert site branding" on public.site_branding;
create policy "Admins can insert site branding"
on public.site_branding for insert
to authenticated
with check (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role = 'admin'
));

drop policy if exists "Admins can update site branding" on public.site_branding;
create policy "Admins can update site branding"
on public.site_branding for update
to authenticated
using (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role = 'admin'
))
with check (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role = 'admin'
));
