/**
 * Resale value table.
 *
 * Each unit of consumed compute / oracle / storage / KYC is worth this much
 * when resold through one of our 22 inbound shims. The barter loop treats
 * these as the floor: if a target's asking * counter_pct still lands above
 * resale * margin, there is no margin to capture and we skip.
 *
 * Numbers are conservative — they reflect what we actually charge today via
 * hive-mcp-compute-grid, hive-mcp-depin, hive-mcp-agent-storage, and
 * hive-mcp-agent-kyc, not aspirational pricing.
 */

export const RESALE_TABLE = {
  llm_token:     { our_buy_floor_usd: 0.000020, our_resell_usd: 0.000040, unit: 'token'  },
  oracle_read:   { our_buy_floor_usd: 0.0008,   our_resell_usd: 0.0015,   unit: 'read'   },
  storage_write: { our_buy_floor_usd: 0.00012,  our_resell_usd: 0.00025,  unit: 'write'  },
  kyc_check:     { our_buy_floor_usd: 0.04,     our_resell_usd: 0.08,     unit: 'check'  },
};

export function classifyAsk(askingDescription) {
  const s = (askingDescription || '').toLowerCase();
  if (s.includes('token') || s.includes('chat') || s.includes('completion') || s.includes('llm')) return 'llm_token';
  if (s.includes('oracle') || s.includes('price') || s.includes('feed')) return 'oracle_read';
  if (s.includes('store') || s.includes('storage') || s.includes('write') || s.includes('depin')) return 'storage_write';
  if (s.includes('kyc') || s.includes('compliance') || s.includes('verify')) return 'kyc_check';
  return null;
}

export function resaleValueFor(category, units) {
  const row = RESALE_TABLE[category];
  if (!row) return null;
  return row.our_resell_usd * Math.max(1, units);
}

export function buyFloorFor(category, units) {
  const row = RESALE_TABLE[category];
  if (!row) return null;
  return row.our_buy_floor_usd * Math.max(1, units);
}
