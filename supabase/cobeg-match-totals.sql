-- Add monthly total counted matches against registered COBEG XI opponents.
-- Run this migration in Supabase SQL Editor.
-- Existing get_leaderboard scoring and ranking logic is unchanged.

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
  JOIN public.cobeg_members AS c
    ON lower(trim(m.opponent_name)) = lower(trim(c.name))
  WHERE m.match_date >= date_trunc('month', p_month)::date
    AND m.match_date < (date_trunc('month', p_month) + interval '1 month')::date
    AND m.status = 'approved'
    AND m.counted = true
  GROUP BY m.player_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_cobeg_match_totals(date) TO anon, authenticated;
