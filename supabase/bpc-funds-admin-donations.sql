-- Restrict donation recording to website administrators.
-- Run in Supabase SQL Editor after the existing BPC Funds migrations.

DROP POLICY IF EXISTS "Authorized users can add BPC donations" ON public.bpc_fund_donations;
DROP POLICY IF EXISTS "Admins can add BPC donations" ON public.bpc_fund_donations;

CREATE POLICY "Admins can add BPC donations"
ON public.bpc_fund_donations FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'admin'
  )
);
