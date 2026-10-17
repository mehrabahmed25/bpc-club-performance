-- Monthly total of approved, counted matches against registered COBEG XI members.
-- This only powers the "Total MP vs COBEG XI" column.
-- It does not modify match records, leaderboard scoring, ranking, or award eligibility.
-- Run this SQL in Supabase SQL Editor to apply the function.

CREATE OR REPLACE FUNCTION public.get_cobeg_match_totals(p_month date)
RETURNS TABLE (
  player_id uuid,
  total_mp_vs_cobeg_xi bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.player_id,
    COUNT(*)::bigint AS total_mp_vs_cobeg_xi
  FROM public.matches AS m
  WHERE m.match_date >= date_trunc('month', p_month)::date
    AND m.match_date < (date_trunc('month', p_month) + interval '1 month')::date
    AND m.status = 'approved'
    AND m.counted = true
    AND EXISTS (
      SELECT 1
      FROM public.cobeg_members AS c
      WHERE lower(trim(c.name)) = lower(trim(m.opponent_name))
    )
  GROUP BY m.player_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_cobeg_match_totals(date) TO anon, authenticated;
