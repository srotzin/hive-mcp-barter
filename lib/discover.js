/**
 * Registry scrapers. Read-only, polite, cached 1h in-process.
 *
 * The 402 ecosystem is small enough that all three registries are reachable
 * via plain HTTPS with no auth. Each scraper emits a normalized
 *   { target_url, registry, name, asking_hint_usd?, asking_description? }
 * record. Pricing is parsed best-effort from public manifests; if a target
 * does not advertise a price, asking_hint_usd is null and the probe step
 * resolves the actual ask.
 */

import { recordTarget } from './ledger.js';

const REGISTRIES = {
  glama: 'https://glama.ai/api/mcp/v1/servers',
  smithery: 'https://smithery.ai/api/registry/servers',
  'mcp.so': 'https://mcp.so/api/servers',
};

const CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchJson(url, timeoutMs = 12000) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'hive-mcp-barter/1.0 (+https://github.com/srotzin/hive-mcp-barter)',
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeGlama(payload) {
  const rows = Array.isArray(payload?.servers) ? payload.servers : Array.isArray(payload) ? payload : [];
  return rows.map(r => ({
    target_url: r.endpoint || r.url || r.mcp_url,
    registry: 'glama',
    name: r.name || r.id,
    asking_hint_usd: r.price_usd ?? r.asking_usd ?? null,
    asking_description: r.description || r.summary || '',
  })).filter(r => r.target_url);
}

function normalizeSmithery(payload) {
  const rows = Array.isArray(payload?.servers) ? payload.servers : Array.isArray(payload) ? payload : [];
  return rows.map(r => ({
    target_url: r.endpoint || r.url || r.transport_url,
    registry: 'smithery',
    name: r.name || r.qualifiedName,
    asking_hint_usd: r.pricing?.usd ?? null,
    asking_description: r.description || '',
  })).filter(r => r.target_url);
}

function normalizeMcpSo(payload) {
  const rows = Array.isArray(payload?.servers) ? payload.servers : Array.isArray(payload) ? payload : [];
  return rows.map(r => ({
    target_url: r.endpoint || r.url,
    registry: 'mcp.so',
    name: r.name,
    asking_hint_usd: r.price_usd ?? null,
    asking_description: r.description || '',
  })).filter(r => r.target_url);
}

export async function discover({ registry = 'glama', limit = 50 } = {}) {
  const key = `${registry}:${limit}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;

  const url = REGISTRIES[registry];
  if (!url) return [];

  const payload = await fetchJson(url);
  if (!payload) {
    const v = [];
    CACHE.set(key, { t: Date.now(), v });
    return v;
  }

  let rows = [];
  if (registry === 'glama') rows = normalizeGlama(payload);
  else if (registry === 'smithery') rows = normalizeSmithery(payload);
  else if (registry === 'mcp.so') rows = normalizeMcpSo(payload);

  rows = rows.slice(0, Math.max(1, limit));
  for (const r of rows) {
    recordTarget({
      target_url: r.target_url,
      registry: r.registry,
      asking_usd: r.asking_hint_usd,
      category: null,
    });
  }
  CACHE.set(key, { t: Date.now(), v: rows });
  return rows;
}

export function listRegistries() {
  return Object.keys(REGISTRIES);
}
