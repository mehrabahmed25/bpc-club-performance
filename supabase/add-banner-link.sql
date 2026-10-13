-- Run this once in Supabase Dashboard > SQL Editor to enable banner destinations.
alter table public.site_posters
add column if not exists link_url text;

comment on column public.site_posters.link_url is
'Optional destination for a homepage banner. Internal values may be home, leaderboard, history, or submit; external links must use http or https.';
