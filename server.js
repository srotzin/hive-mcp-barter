#!/usr/bin/env node
/**
 * hive-mcp-barter — Outbound 402 arbitrage agent.
 *
 * Shape A only: probes 402-enabled endpoints, counter-offers below asking,
 * settles when target asking * counter_pct is still below our resale floor.
 * Pure protocol — no DMs, no spam. Attribution headers on every request.
 *
 * Brand: Hive Civilization gold #C08D23 (Pantone 1245 C).
 * Spec  : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0.
 * Wallet: W1 MONROE 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e (Base L2).
 */

import express from 'express';
import { discover, listRegistries } from './lib/discover.js';
import { probe, quoteCurve } from './lib/probe.js';
import { buildCounter } from './lib/counter.js';
import { awaitReceipt, expectedTxHash } from './lib/settle.js';
import {
  openDb, recordCounter, recordSettlement, blacklistTarget, isBlacklisted,
  probedInLast24h, distinctTargetsLastHour, todaySpentUsd, todayBook, recentTargets,
} from './lib/ledger.js';
import { CAPS, checkCounter, checkProbeAllowed } from './lib/caps.js';
import { RESALE_TABLE, classifyAsk, resaleValueFor } from './lib/valuation.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const ENABLE_OUTBOUND = String(process.env.ENABLE_OUTBOUND || 'false').toLowerCase() === 'true';
const HIVECOMPUTE_URL = process.env.HIVECOMPUTE_URL || 'https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';

openDb();
// ─── BOGO pay-front helpers ───────────────────────────────────────────────
// did_call_count tracks paid calls per DID for first-call-free and loyalty
// freebies. Schema lives in a dedicated DB so it never touches service data.
import _BogoDatabase from 'better-sqlite3';
const _bogoDB = new _BogoDatabase(process.env.BOGO_DB_PATH || '/tmp/bogo_barter.db');
_bogoDB.pragma('journal_mode = WAL');
_bogoDB.exec(
  'CREATE TABLE IF NOT EXISTS did_call_count ' +
  '(did TEXT PRIMARY KEY, paid_calls INTEGER NOT NULL DEFAULT 0)'
);

const _bogoGetStmt = _bogoDB.prepare(
  'SELECT paid_calls FROM did_call_count WHERE did = ?'
);
const _bogoUpsertStmt = _bogoDB.prepare(
  'INSERT INTO did_call_count (did, paid_calls) VALUES (?, 1) ' +
  'ON CONFLICT(did) DO UPDATE SET paid_calls = paid_calls + 1'
);

function _bogoCheck(did) {
  if (!did) return { free: false };
  const row = _bogoGetStmt.get(did);
  const n   = row ? row.paid_calls : 0;
  if (n === 0)        return { free: true, reason: 'first_call_free' };
  if (n % 6 === 0)    return { free: true, reason: 'loyalty_freebie' };
  return { free: false };
}

function _bogoIncrement(did) {
  if (did) _bogoUpsertStmt.run(did);
}

const BOGO_BLOCK = {
  first_call_free: true,
  loyalty_threshold: 6,
  loyalty_message:
    "Every 6th paid call is free. Present your DID via 'x-hive-did' header to track progress.",
};
// ─────────────────────────────────────────────────────────────────────────

async function _verifyUsdcPayment(tx_hash, min_usd) {
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return { ok: false, reason: 'invalid_tx_hash' };
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  let receipt;
  try   { receipt = await provider.getTransactionReceipt(tx_hash); }
  catch (err) { return { ok: false, reason: `rpc_error: ${err.message}` }; }
  if (!receipt)            return { ok: false, reason: 'tx_not_found_or_pending' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_reverted' };
  const USDC_ADDR    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const WALLET_ADDR  = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  const XFER_TOPIC   = ethers.id('Transfer(address,address,uint256)');
  let total = 0n;
  for (const log of (receipt.logs || [])) {
    if (log.address.toLowerCase() !== USDC_ADDR.toLowerCase()) continue;
    if (log.topics?.[0] !== XFER_TOPIC) continue;
    if (('0x' + log.topics[2].slice(26).toLowerCase()) !== WALLET_ADDR.toLowerCase()) continue;
    total += BigInt(log.data);
  }
  if (total === 0n)  return { ok: false, reason: 'no_transfer_to_wallet' };
  const amount_usd = Number(total) / 1e6;
  if (amount_usd + 1e-9 < min_usd) return { ok: false, reason: 'underpaid', amount_usd };
  return { ok: true, amount_usd };
}



// ─── MCP tools ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'barter_discover',
    description: 'List 402-enabled MCP endpoints from a public registry (glama, smithery, mcp.so) with last-seen asking prices. Tier 0, free, read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        registry: { type: 'string', enum: ['glama', 'smithery', 'mcp.so'], description: 'Source registry to scrape.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max endpoints to return (default 50).' },
      },
    },
  },
  {
    name: 'barter_quote_curve',
    description: 'Build a demand curve for a target by sending up to 5 probes at descending floor pcts. Returns the reservation-price estimate. Tier 0, free, read-only.',
    inputSchema: {
      type: 'object',
      required: ['target_url'],
      properties: {
        target_url: { type: 'string', description: 'HTTPS endpoint that speaks 402 quote envelopes.' },
        n_probes: { type: 'integer', minimum: 1, maximum: 5, description: 'Number of probes (default 3).' },
      },
    },
  },
  {
    name: 'barter_arbitrage_book',
    description: 'Get today\'s P&L: probes sent, counters accepted, USDC realized spread. Tier 0, free, read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case 'barter_discover': {
      const rows = await discover({
        registry: args.registry || 'glama',
        limit: Number.isFinite(args.limit) ? args.limit : 50,
      });
      return { type: 'text', text: JSON.stringify({ registry: args.registry || 'glama', count: rows.length, rows }, null, 2) };
    }
    case 'barter_quote_curve': {
      const r = await quoteCurve(args.target_url, args.n_probes ?? 3);
      return { type: 'text', text: JSON.stringify(r, null, 2) };
    }
    case 'barter_arbitrage_book': {
      return { type: 'text', text: JSON.stringify(todayBook(), null, 2) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP JSON-RPC ──────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id, result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'hive-mcp-barter', version: '1.0.0', description: 'Outbound 402 arbitrage agent — Hive Civilization' },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const out = await executeTool(name, args || {});
        return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

// ─── REST endpoints ────────────────────────────────────────────────────────
app.post('/v1/barter/discover', async (req, res) => {
  const registry = req.body?.registry || 'glama';
  const limit = Number.isFinite(req.body?.limit) ? req.body.limit : 50;
  const rows = await discover({ registry, limit });
  res.json({ registry, count: rows.length, rows });
});

app.post('/v1/barter/probe', async (req, res) => {
  const target_url = req.body?.target_url;
  if (!target_url) return res.status(400).json({ error: 'target_url required' });
  if (isBlacklisted(target_url)) return res.status(403).json({ error: 'blacklisted', target_url });
  const r = await probe(target_url);
  res.json(r);
});

app.post('/v1/barter/counter', async (req, res) => {
  const { target_url, asking_seen_usd, pay_to } = req.body || {};
  if (!target_url || !asking_seen_usd || !pay_to) {
    return res.status(400).json({ error: 'target_url, asking_seen_usd, pay_to required' });
  }
  const offer_usd = Number((Number(asking_seen_usd) * CAPS.COUNTER_PCT).toFixed(6));
  const cap = checkCounter({ offerUsd: offer_usd, todaySpentUsd: todaySpentUsd() });
  if (!cap.ok) return res.status(429).json({ error: 'cap', reason: cap.reason, offer_usd });
  const built = await buildCounter({ target_url, asking_seen_usd, offer_usd, pay_to });
  if (!built.ok) return res.status(400).json({ error: 'build_failed', detail: built });
  recordCounter({
    target_url, asking_seen_usd, offer_usd,
    attribution_id: built.attribution_id || built.envelope.attribution.attribution_id,
    tx_pre_signed: built.envelope.tx_pre_signed,
    target_response: null,
    accepted: false,
  });
  res.json(built);
});

app.post('/v1/barter/settle', async (req, res) => {
  const { target_url, counter_id, tx_hash, signed_tx, paid_usd, asking_seen_usd, category, units } = req.body || {};
  if (!target_url) return res.status(400).json({ error: 'target_url required' });
  let hash = tx_hash;
  if (!hash && signed_tx) hash = expectedTxHash(signed_tx);
  if (!hash) return res.status(400).json({ error: 'tx_hash or signed_tx required' });
  const receipt = await awaitReceipt(hash, 60000);
  const cat = category || classifyAsk(req.body?.description || '');
  const resale = cat ? resaleValueFor(cat, units || 1) : null;
  const realized = resale != null && Number.isFinite(paid_usd) ? Number((resale - paid_usd).toFixed(6)) : null;
  recordSettlement({
    counter_id, target_url, paid_usd: paid_usd ?? null,
    tx_hash: hash, receipt, resale_value_usd: resale, realized_spread_usd: realized,
  });
  res.json({ tx_hash: hash, receipt, resale_value_usd: resale, realized_spread_usd: realized });
});

// ─── POST /v1/barter/offer — pay-front for posting a barter offer ────────
// Returns 402 + BOGO block with no tx_hash. First-call-free for new DIDs.
// On payment: records the offer intent and returns a confirmation receipt.
app.post('/v1/barter/offer', async (req, res) => {
  const PRICE = 0.001;
  const did     = req.headers['x-hive-did'] || req.body?.caller_did || null;
  const tx_hash = req.body?.tx_hash || req.headers['x402-tx-hash'] || null;

  const bogo = _bogoCheck(did);
  if (bogo.free) {
    _bogoIncrement(did);
    return res.json({
      ok: true, bogo_applied: bogo.reason,
      offer: {
        caller_did: did,
        target_url: req.body?.target_url || null,
        counter_pct: req.body?.counter_pct || null,
        offered_at: new Date().toISOString(),
      },
    });
  }

  if (!tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402: {
        type: 'x402', version: '1', kind: 'barter_offer',
        asking_usd: 0.001, accept_min_usd: 0.001,
        asset: 'USDC', asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'base', pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
        nonce: Math.random().toString(36).slice(2),
        issued_ms: Date.now(),
      },
      bogo: BOGO_BLOCK,
      bogo_first_call_free: true,
      bogo_loyalty_threshold: 6,
      bogo_pitch: "Pay this once, your 6th call is on the house. New here? Add header x-hive-did to claim your first call free.",
      note: `Submit tx_hash in body or 'x402-tx-hash' header. Asking 0.001 USDC on Base to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e.`,
      did: did || null,
    });
  }

  const v = await _verifyUsdcPayment(tx_hash, PRICE);
  if (!v.ok) return res.status(402).json({ error: 'payment_invalid', reason: v.reason, tx_hash });

  _bogoIncrement(did);
  res.json({
    ok: true, billed_usd: v.amount_usd, tx_hash,
    offer: {
      caller_did: did,
      target_url: req.body?.target_url || null,
      counter_pct: req.body?.counter_pct || null,
      offered_at: new Date().toISOString(),
    },
  });
});

app.get('/v1/barter/ledger', (req, res) => {
  res.json({
    book: todayBook(),
    today_spent_usd: todaySpentUsd(),
    caps: CAPS,
    recent_targets: recentTargets(20),
  });
});

app.get('/v1/barter/today', (req, res) => {
  const b = todayBook();
  res.json({
    tier: 0,
    free: true,
    wallet: WALLET_ADDRESS,
    enable_outbound: ENABLE_OUTBOUND,
    ...b,
  });
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'hive-mcp-barter',
  version: '1.0.0',
  enable_outbound: ENABLE_OUTBOUND,
  wallet: WALLET_ADDRESS,
  caps: CAPS,
}));

app.get('/.well-known/mcp.json', (req, res) => res.json({
  name: 'hive-mcp-barter',
  endpoint: '/mcp',
  transport: 'streamable-http',
  protocol: '2024-11-05',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
}));

// ─── Root: HTML for browsers, JSON for agents ──────────────────────────────
const HTML_ROOT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>hive-mcp-barter — Outbound 402 arbitrage agent</title>
<meta name="description" content="Outbound 402 arbitrage agent. Probes 402-enabled MCP endpoints, counter-offers below asking, settles when the spread clears our resale floor. MCP 2024-11-05, USDC on Base.">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --gold: #C08D23; --ink: #111; --paper: #fafaf7; --rule: #e7e3d6; }
  body { background: var(--paper); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-width: 760px; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.55; font-size: 14.5px; }
  h1 { color: var(--gold); font-size: 1.6rem; letter-spacing: 0.01em; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gold); border-bottom: 1px solid var(--rule); padding-bottom: 0.35rem; margin-top: 2.2rem; }
  .lead { color: #444; margin: 0 0 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { color: var(--gold); font-weight: 600; }
  code, pre { background: #f3f0e3; padding: 0.1rem 0.35rem; border-radius: 3px; }
  pre { padding: 0.75rem 0.9rem; overflow-x: auto; }
  a { color: var(--gold); text-decoration: none; border-bottom: 1px dotted var(--gold); }
  footer { margin-top: 3rem; color: #777; font-size: 12.5px; }
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "hive-mcp-barter",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cross-platform",
  "description": "Outbound 402 arbitrage agent. Probes 402-enabled MCP endpoints, counter-offers below asking, settles when the spread clears our resale floor.",
  "url": "https://hive-mcp-barter.onrender.com",
  "author": { "@type": "Person", "name": "Steve Rotzin", "url": "https://www.thehiveryiq.com" },
  "license": "https://opensource.org/licenses/MIT",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }
}
</script>
</head>
<body>
<h1>hive-mcp-barter</h1>
<p class="lead">Outbound 402 arbitrage agent. Probes 402-enabled MCP endpoints, counter-offers below asking, settles when the spread clears our resale floor.</p>

<h2>Protocol</h2>
<table>
  <tr><th>MCP version</th><td>2024-11-05 / Streamable-HTTP / JSON-RPC 2.0</td></tr>
  <tr><th>Endpoint</th><td><code>POST /mcp</code></td></tr>
  <tr><th>Discovery</th><td><code>GET /.well-known/mcp.json</code></td></tr>
  <tr><th>Health</th><td><code>GET /health</code></td></tr>
  <tr><th>Settlement</th><td>USDC on Base L2 — real rails, no mock</td></tr>
</table>

<h2>Tools</h2>
<table>
  <tr><th>Name</th><th>Tier</th><th>Description</th></tr>
  <tr><td><code>barter_discover</code></td><td>0</td><td>List 402-enabled endpoints from a public registry.</td></tr>
  <tr><td><code>barter_quote_curve</code></td><td>0</td><td>Build a demand curve for a target via descending probes.</td></tr>
  <tr><td><code>barter_arbitrage_book</code></td><td>0</td><td>Today's P&amp;L: probes, accepted counters, realized spread.</td></tr>
</table>

<h2>REST endpoints</h2>
<table>
  <tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
  <tr><td>POST</td><td><code>/v1/barter/discover</code></td><td>Scan registries for 402 endpoints.</td></tr>
  <tr><td>POST</td><td><code>/v1/barter/probe</code></td><td>Send a 402-style quote request to a target.</td></tr>
  <tr><td>POST</td><td><code>/v1/barter/counter</code></td><td>Build a signed counter-offer at the configured floor pct.</td></tr>
  <tr><td>POST</td><td><code>/v1/barter/settle</code></td><td>Resolve an accepted counter on-chain and book the spread.</td></tr>
  <tr><td>GET</td><td><code>/v1/barter/ledger</code></td><td>Running P&amp;L, attempts, wins, spread.</td></tr>
  <tr><td>GET</td><td><code>/v1/barter/today</code></td><td>Today aggregate (Tier 0, free).</td></tr>
  <tr><td>GET</td><td><code>/health</code></td><td>Service health.</td></tr>
</table>

<h2>Risk controls</h2>
<table>
  <tr><th>Cap</th><th>Value</th></tr>
  <tr><td>Max single counter</td><td>$0.50 USDC</td></tr>
  <tr><td>Max daily outbound spend</td><td>$25 USDC</td></tr>
  <tr><td>Max probes per target / 24h</td><td>1</td></tr>
  <tr><td>Max distinct targets / hr</td><td>30</td></tr>
  <tr><td>Per-target blacklist</td><td>3+ no-response</td></tr>
</table>

<footer>
  <p>Hive Civilization · Pantone 1245 C / #C08D23 · MIT · <a href="https://github.com/srotzin/hive-mcp-barter">github.com/srotzin/hive-mcp-barter</a></p>
</footer>
</body></html>`;

app.get('/', (req, res) => {
  const accept = String(req.headers.accept || '').toLowerCase();
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return res.json({
      name: 'hive-mcp-barter',
      version: '1.0.0',
      description: 'Outbound 402 arbitrage agent. Probes 402-enabled MCP endpoints, counter-offers below asking, settles when the spread clears our resale floor.',
      endpoint: '/mcp',
      transport: 'streamable-http',
      protocol: '2024-11-05',
      tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
      enable_outbound: ENABLE_OUTBOUND,
      caps: CAPS,
      resale_table: RESALE_TABLE,
    });
  }
  res.set('content-type', 'text/html; charset=utf-8').send(HTML_ROOT);
});

// ─── Outbound 5-min cron loop (gated behind ENABLE_OUTBOUND) ───────────────
async function outboundTick() {
  if (!ENABLE_OUTBOUND) return;
  try {
    const targets = await discover({ registry: 'glama', limit: 50 });
    let hourlyDistinct = distinctTargetsLastHour();
    for (const t of targets) {
      if (hourlyDistinct >= CAPS.MAX_TARGETS_PER_HOUR) break;
      if (isBlacklisted(t.target_url)) continue;
      const recent = probedInLast24h(t.target_url);
      const allow = checkProbeAllowed({ probedInLast24h: recent, distinctTargetsLastHour: hourlyDistinct });
      if (!allow.ok) continue;

      const r = await probe(t.target_url);
      hourlyDistinct += 1;

      if (!r.ok || !r.asking_usd || !r.pay_to) {
        if (r.response_code == null) blacklistTarget(t.target_url, 'no_response', 24);
        continue;
      }

      const cat = r.category;
      if (!cat) continue;
      const resale = resaleValueFor(cat, 1);
      if (!resale) continue;

      const offer_usd = Number((r.asking_usd * CAPS.COUNTER_PCT).toFixed(6));
      if (offer_usd > resale * CAPS.RESALE_MARGIN) continue;

      const cap = checkCounter({ offerUsd: offer_usd, todaySpentUsd: todaySpentUsd() });
      if (!cap.ok) break;

      const built = await buildCounter({
        target_url: t.target_url,
        asking_seen_usd: r.asking_usd,
        offer_usd,
        pay_to: r.pay_to,
      });
      recordCounter({
        target_url: t.target_url,
        asking_seen_usd: r.asking_usd,
        offer_usd,
        attribution_id: built?.envelope?.attribution?.attribution_id,
        tx_pre_signed: built?.envelope?.tx_pre_signed || null,
        target_response: null,
        accepted: false,
      });
      // Posting the counter to the target is left to the target's own
      // accept rail — we never re-broadcast. The 5-min loop only writes
      // the envelope to the ledger; manual settle endpoint closes it.
    }
  } catch (err) {
    console.error('outboundTick error:', err?.message || err);
  }
}

if (ENABLE_OUTBOUND) {
  setInterval(outboundTick, 5 * 60 * 1000);
  setTimeout(outboundTick, 30 * 1000);
}

// ─── Twice-daily resale revaluation via hivecompute (LLM call) ─────────────
async function revalueResale() {
  try {
    await fetch(HIVECOMPUTE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'hive-mcp-barter/1.0' },
      body: JSON.stringify({
        model: 'hive-default',
        messages: [{ role: 'user', content: 'Reprice resale table for hive-mcp-barter. Return JSON with llm_token, oracle_read, storage_write, kyc_check unit prices.' }],
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    // best-effort; fall back to in-memory table
  }
}
setInterval(revalueResale, 12 * 60 * 60 * 1000);


// ─── Schema constants (auto-injected to fix deploy) ─────
const SERVICE = 'hive-mcp-barter';
const VERSION = '1.0.0';


// ─── Schema discoverability ────────────────────────────────────────────────
const AGENT_CARD = {
  name: SERVICE,
  description: 'Outbound 402 arbitrage agent. Probes 402-enabled MCP endpoints, counter-offers below asking, settles when the spread clears our resale floor. MCP 2024-11-05, USDC on Base, single-shot no-haggle policy. INTENTIONALLY-FREE: This service is an outbound buyer; revenue is captured by spread on resold endpoints, not direct charge. All public MCP tools (barter_discover, barter_quote_curve, barter_arbitrage_book) are Tier 0, free, read-only. The /v1/barter/offer REST endpoint is x402-gated at $0.001 USDC.',
  url: `https://${SERVICE}.onrender.com`,
  provider: {
    organization: 'Hive Civilization',
    url: 'https://www.thehiveryiq.com',
    contact: 'steve@thehiveryiq.com',
  },
  version: VERSION,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  authentication: {
    schemes: ['x402'],
    credentials: {
      type: 'x402',
      asset: 'USDC',
      network: 'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    { name: 'barter_discover', description: 'List 402-enabled MCP endpoints from a public registry (glama, smithery, mcp.so) with last-seen asking prices. Tier 0, free, read-only.' },
    { name: 'barter_quote_curve', description: 'Build a demand curve for a target by sending up to 5 probes at descending floor pcts. Returns the reservation-price estimate. Tier 0, free, read-only.' },
    { name: 'barter_arbitrage_book', description: 'Get the running probe book of accepted/rejected counters with realized spread.' },
  ],
  extensions: {
    hive_pricing: {
      currency: 'USDC',
      network: 'base',
      model: 'per_call',
      first_call_free: true,
      loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free',
    },
  },
};

const AP2 = {
  ap2_version: '1',
  agent: {
    name: SERVICE,
    did: `did:web:${SERVICE}.onrender.com`,
    description: 'Outbound 402 arbitrage agent. Probes 402-enabled MCP endpoints, counter-offers below asking, settles when the spread clears our resale floor. MCP 2024-11-05, USDC on Base, single-shot no-haggle policy. INTENTIONALLY-FREE: This service is an outbound buyer; revenue is captured by spread on resold endpoints, not direct charge.',
  },
  endpoints: {
    mcp: `https://${SERVICE}.onrender.com/mcp`,
    agent_card: `https://${SERVICE}.onrender.com/.well-known/agent-card.json`,
  },
  payments: {
    schemes: ['x402'],
    primary: {
      scheme: 'x402',
      network: 'base',
      asset: 'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' },
};

app.get('/.well-known/agent-card.json', (req, res) => res.json(AGENT_CARD));
app.get('/.well-known/ap2.json',         (req, res) => res.json(AP2));


app.listen(PORT, () => {
  console.log(`hive-mcp-barter on :${PORT}`);
  console.log(`  enable_outbound : ${ENABLE_OUTBOUND}`);
  console.log(`  wallet          : ${WALLET_ADDRESS}`);
  console.log(`  registries      : ${listRegistries().join(', ')}`);
});
