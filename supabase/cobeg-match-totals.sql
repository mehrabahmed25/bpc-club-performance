-- Monthly total of approved, counted matches for each player against registered COBEG XI members.
-- Credit each qualifying match to BOTH sides:
--   1. the player who submitted the match (matches.player_id)
--   2. the registered COBEG XI member named as the opponent
-- This only powers "Total MP vs COBEG XI"; it does not edit match records or other rules.

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
  WITH qualifying_matches AS (
    SELECT
      m.player_id AS submitter_player_id,
      c.id AS opponent_player_id
    FROM public.matches AS m
    JOIN public.cobeg_members AS c
      ON lower(trim(m.opponent_name)) = lower(trim(c.name))
    WHERE m.match_date >= date_trunc('month', p_month)::date
      AND m.match_date < (date_trunc('month', p_month) + interval '1 month')::date
      AND m.status = 'approved'
      AND m.counted = true
  ),
  credited_players AS (
    SELECT submitter_player_id AS player_id
    FROM qualifying_matches

    UNION ALL

    SELECT p.id AS player_id
    FROM qualifying_matches q
    JOIN public.players AS p
      ON p.id = q.opponent_player_id
  )
  SELECT
    player_id,
    COUNT(*)::bigint AS total_mp_vs_cobeg_xi
  FROM credited_players
  GROUP BY player_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_cobeg_match_totals(date) TO anon, authenticated;
