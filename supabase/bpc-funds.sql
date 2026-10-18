-- Private BPC Funds donation ledger and per-user access control.
-- Run this migration in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.bpc_funds_access (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bpc_fund_donations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_name text NOT NULL CHECK (length(trim(donor_name)) > 0),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  donation_date date NOT NULL,
  note text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bpc_funds_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bpc_fund_donations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_access_bpc_funds()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR EXISTS (SELECT 1 FROM public.bpc_funds_access a WHERE a.user_id = auth.uid());
$$;

DROP POLICY IF EXISTS "Admins manage BPC funds access" ON public.bpc_funds_access;
CREATE POLICY "Admins manage BPC funds access"
ON public.bpc_funds_access FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS "Users can see own BPC funds access" ON public.bpc_funds_access;
CREATE POLICY "Users can see own BPC funds access"
ON public.bpc_funds_access FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Authorized users can view BPC donations" ON public.bpc_fund_donations;
CREATE POLICY "Authorized users can view BPC donations"
ON public.bpc_fund_donations FOR SELECT TO authenticated
USING (public.can_access_bpc_funds());

DROP POLICY IF EXISTS "Authorized users can add BPC donations" ON public.bpc_fund_donations;
CREATE POLICY "Authorized users can add BPC donations"
ON public.bpc_fund_donations FOR INSERT TO authenticated
WITH CHECK (public.can_access_bpc_funds() AND created_by = auth.uid());

DROP POLICY IF EXISTS "Admins can update BPC donations" ON public.bpc_fund_donations;
CREATE POLICY "Admins can update BPC donations"
ON public.bpc_fund_donations FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS "Admins can delete BPC donations" ON public.bpc_fund_donations;
CREATE POLICY "Admins can delete BPC donations"
ON public.bpc_fund_donations FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bpc_funds_access TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bpc_fund_donations TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_bpc_funds() TO authenticated;
