-- BPC Tournaments read-only preflight and regression checks.
-- Run this BEFORE applying any tournament migration in Supabase SQL Editor.
-- This script does not insert, update, or delete data.
do $$
declare v_missing text[] := '{}';
begin
 if to_regclass('public.profiles') is null then v_missing:=array_append(v_missing,'public.profiles'); end if;
 if to_regclass('public.cobeg_members') is null then v_missing:=array_append(v_missing,'public.cobeg_members'); end if;
 if to_regclass('public.players') is null then v_missing:=array_append(v_missing,'public.players'); end if;
 if to_regclass('public.matches') is null then
   raise notice 'No public.matches table found (may be expected if friendly matches use another name).';
 end if;
 if to_regprocedure('public.tournament_is_admin()') is not null then
   raise notice 'Tournament functions already exist; inspect current deployment before re-running migrations.';
 end if;
 if cardinality(v_missing)>0 then
   raise exception 'Preflight failed: required existing tables missing: %',array_to_string(v_missing,', ');
 end if;
 raise notice 'Basic table preflight passed. Review the following query outputs and verify column types/RLS before applying migrations.';
end $$;

-- Inventory existing schema, policies, and function signatures.
select table_name,column_name,data_type,udt_name,is_nullable
from information_schema.columns
where table_schema='public' and table_name in
 ('profiles','players','cobeg_members','matches','official_matches','bpc_fund_donations','bpc_fund_expenses','bpc_funds_access')
order by table_name,ordinal_position;

select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies where schemaname='public'
and tablename in ('profiles','players','cobeg_members','matches','official_matches','bpc_fund_donations','bpc_fund_expenses','bpc_funds_access')
order by tablename,policyname;

select n.nspname as schema_name,p.proname as function_name,pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
and (p.proname ilike '%match%' or p.proname ilike '%fund%' or p.proname ilike '%admin%')
order by p.proname;

-- After migrations, run these read-only isolation checks.
select 'tournament_tables' as check_name,count(*) as object_count
from information_schema.tables where table_schema='public' and table_name like 'tournament\_%' escape '\';

select 'tournament_functions' as check_name,count(*) as object_count
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'tournament\_%' escape '\';

-- Tournament-only code should not reference friendly match/funds tables from its functions.
select p.proname,pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'tournament\_%' escape '\'
and (pg_get_functiondef(p.oid) ilike '%bpc_fund_%'
  or pg_get_functiondef(p.oid) ilike '%official_matches%'
  or pg_get_functiondef(p.oid) ilike '%public.matches%');

-- Result rows must not appear in the existing friendly match table.
-- This is a structural check only: tournament tables use their own prefix.
