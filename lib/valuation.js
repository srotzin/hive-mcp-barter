/**
 * Resale value table.
 *
 * Each unit of consumed compute / oracle / storage / KYC is worth this much
 * when resold through one of our 22 inbound shims. The barter loop treats
 * verified entries as the floor: if a target's asking * counter_pct still
 * lands above resale * margin, there is no margin to capture and we skip.
 *
 * Numbers reflect what we actually charge today via hive-mcp-compute-grid,
 * hive-mcp-depin, hive-mcp-agent-storage, and hive-mcp-agent-kyc, except
 * where verified=false — those are placeholders awaiting real probe data
 * and MUST NOT be used to gate counter-offers.
 */

export const RESALE_TABLE = {
  llm_tokens:     { cost_usd_per_unit: 0.000020, resale_usd_per_unit: 0.000040, verified: true,  source: 'hivecompute metered both sides',                            unit: 'token' },
  standard_402:   { cost_usd_per_unit: null,     resale_usd_per_unit: null,     verified: true,  source: 'passes through hivemorph 402 envelope at advertised asking', unit: 'envelope' },
  oracle_reads:   { cost_usd_per_unit: 0.0008,   resale_usd_per_unit: 0.0015,   verified: false, source: 'estimate, awaiting probe data',                              unit: 'read' },
  storage_writes: { cost_usd_per_unit: 0.00012,  resale_usd_per_unit: 0.00025,  verified: false, source: 'estimate, awaiting probe data',                              unit: 'write' },
  kyc_checks:     { cost_usd_per_unit: 0.04,     resale_usd_per_unit: 0.08,     verified: false, source: 'estimate, awaiting probe data',                              unit: 'check' },
};

export function classifyAsk(askingDescription) {
  const s = (askingDescription || '').toLowerCase();
  if (s.includes('token') || s.includes('chat') || s.includes('completion') || s.includes('llm')) return 'llm_tokens';
  if (s.includes('oracle') || s.includes('price') || s.includes('feed')) return 'oracle_reads';
  if (s.includes('store') || s.includes('storage') || s.includes('write') || s.includes('depin')) return 'storage_writes';
  if (s.includes('kyc') || s.includes('compliance') || s.includes('verify')) return 'kyc_checks';
  return null;
}

export function resaleValueFor(category, units) {
  const row = RESALE_TABLE[category];
  if (!row || row.resale_usd_per_unit == null) return null;
  return row.resale_usd_per_unit * Math.max(1, units);
}

export function buyFloorFor(category, units) {
  const row = RESALE_TABLE[category];
  if (!row || row.cost_usd_per_unit == null) return null;
  return row.cost_usd_per_unit * Math.max(1, units);
}

export function isVerified(category) {
  const row = RESALE_TABLE[category];
  return !!(row && row.verified === true && row.resale_usd_per_unit != null);
}
