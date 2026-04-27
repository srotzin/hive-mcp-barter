/**
 * Risk-control gate. All caps fail-closed.
 *
 * Hard ceilings:
 *   - Max single counter        $0.50 USDC
 *   - Max daily outbound spend  $25 USDC
 *   - Max probes per target/24h  1
 *   - Max distinct targets/hr    30
 *   - Per-target blacklist on 3+ no-response
 *
 * Configurable via env, but a missing/invalid env var falls back to the
 * stricter hardcoded default.
 */

const N = (k, d) => {
  const v = parseFloat(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : d;
};

export const CAPS = {
  MAX_SINGLE_COUNTER_USD:    N('MAX_SINGLE_COUNTER_USD',    0.50),
  MAX_DAILY_SPEND_USD:       N('MAX_DAILY_SPEND_USD',       25),
  MAX_PROBES_PER_TARGET_24H: N('MAX_PROBES_PER_TARGET_24H',  1),
  MAX_TARGETS_PER_HOUR:      N('MAX_TARGETS_PER_HOUR',      30),
  BLACKLIST_NO_RESPONSE:     N('BLACKLIST_NO_RESPONSE',      3),
  COUNTER_PCT:               N('COUNTER_PCT',                0.65),
  RESALE_MARGIN:             N('RESALE_MARGIN',              0.95),
};

export function checkCounter({ offerUsd, todaySpentUsd }) {
  if (!Number.isFinite(offerUsd) || offerUsd <= 0) return { ok: false, reason: 'invalid_offer' };
  if (offerUsd > CAPS.MAX_SINGLE_COUNTER_USD)      return { ok: false, reason: 'over_single_cap' };
  if (todaySpentUsd + offerUsd > CAPS.MAX_DAILY_SPEND_USD) return { ok: false, reason: 'over_daily_cap' };
  return { ok: true };
}

export function checkProbeAllowed({ probedInLast24h, distinctTargetsLastHour }) {
  if (probedInLast24h >= CAPS.MAX_PROBES_PER_TARGET_24H) return { ok: false, reason: 'recent_probe' };
  if (distinctTargetsLastHour >= CAPS.MAX_TARGETS_PER_HOUR) return { ok: false, reason: 'hourly_target_cap' };
  return { ok: true };
}
