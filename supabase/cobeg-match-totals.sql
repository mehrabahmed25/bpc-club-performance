-- Monthly total of approved, counted matches involving registered COBEG XI members.
-- Credit each match to a player only when their opponent is a registered COBEG XI member.
-- The submitter is not automatically credited just for submitting the result.
-- This function does not edit match records or any other rules.

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
  WITH monthly_matches AS (
    SELECT
      m.id AS match_id,
      m.player_id AS submitter_player_id,
      m.opponent_name,
      m.match_date
    FROM public.matches AS m
    WHERE m.match_date >= date_trunc('month', p_month)::date
      AND m.match_date < (date_trunc('month', p_month) + interval '1 month')::date
      AND m.status = 'approved'
      AND m.counted = true
  ),
  credited_players AS (
    -- Credit the submitter only when the named opponent is a COBEG XI member.
    SELECT
      m.match_id,
      m.submitter_player_id AS player_id
    FROM monthly_matches AS m
    WHERE EXISTS (
      SELECT 1
      FROM public.cobeg_members AS c
      WHERE lower(trim(c.name)) = lower(trim(m.opponent_name))
        AND c.active = true
    )

    UNION

    -- Credit the opponent's player profile when the submitter is a COBEG XI member.
    -- This works even when the opponent was entered through the "Other Opponent" section.
    SELECT
      m.match_id,
      opponent.id AS player_id
    FROM monthly_matches AS m
    JOIN public.players AS submitter
      ON submitter.id = m.submitter_player_id
    JOIN public.cobeg_members AS c
      ON lower(trim(c.name)) = lower(trim(submitter.display_name))
      AND c.active = true
    JOIN public.players AS opponent
      ON lower(trim(opponent.display_name)) = lower(trim(m.opponent_name))
  )
  SELECT
    player_id,
    COUNT(DISTINCT match_id)::bigint AS total_mp_vs_cobeg_xi
  FROM credited_players
  GROUP BY player_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_cobeg_match_totals(date) TO anon, authenticated;
