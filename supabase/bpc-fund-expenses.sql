-- BPC Funds expenses and balance support.
-- Run in Supabase SQL Editor after the original bpc-funds.sql migration.

CREATE TABLE IF NOT EXISTS public.bpc_fund_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  expense_date date NOT NULL,
  note text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bpc_fund_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can view BPC expenses" ON public.bpc_fund_expenses;
CREATE POLICY "Authorized users can view BPC expenses"
ON public.bpc_fund_expenses FOR SELECT TO authenticated
USING (public.can_access_bpc_funds());

DROP POLICY IF EXISTS "Admins can add BPC expenses" ON public.bpc_fund_expenses;
CREATE POLICY "Admins can add BPC expenses"
ON public.bpc_fund_expenses FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);

DROP POLICY IF EXISTS "Admins can update BPC expenses" ON public.bpc_fund_expenses;
CREATE POLICY "Admins can update BPC expenses"
ON public.bpc_fund_expenses FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS "Admins can delete BPC expenses" ON public.bpc_fund_expenses;
CREATE POLICY "Admins can delete BPC expenses"
ON public.bpc_fund_expenses FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bpc_fund_expenses TO authenticated;
