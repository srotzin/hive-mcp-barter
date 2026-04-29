/**
 * 402 quote requester.
 *
 * Sends a standard 402 RFQ to a target endpoint and parses the response.
 * Three terminal outcomes:
 *   - 402 envelope returned with x402_version + asking_usd → quoted
 *   - any other 2xx/4xx → recorded as response_code, no quote
 *   - timeout / network error → no_response (caller may blacklist)
 *
 * Side effects on every probe with a parseable envelope:
 *   - any accepts[] capability+price tuples are appended to the
 *     discovered_capabilities table (price discovery is the product)
 *   - if the envelope reports reason="below_floor" with a known floor,
 *     a calibration ping is emitted to AUCTION_HOOK_URL (best-effort,
 *     fail-silent — auction service may not have the receiving endpoint
 *     yet).
 *
 * Polite: 10s hard timeout, attribution headers on every request, never
 * retried within the same probe call.
 */

import { createHmac } from 'crypto';
import { recordProbe, recordDiscoveredCapability } from './ledger.js';
import { classifyAsk } from './valuation.js';

const PROBE_TIMEOUT_MS = 10000;
const AUCTION_HOOK_URL = process.env.AUCTION_HOOK_URL || 'https://hive-mcp-auction.onrender.com/v1/auction/calibrate';

function attributionHeaders() {
  return {
    'user-agent': 'hive-mcp-barter/1.0 (+https://github.com/srotzin/hive-mcp-barter)',
    'x-hive-attribution': 'hive-mcp-barter',
    'x-hive-originator-did': 'did:hive:morph',
    'accept': 'application/json',
  };
}

function parse402Envelope(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.x402_version == null) return null;
  const askingUsd = Number(body.asking_usd ?? body.amount_usd ?? body.price_usd);
  const hasTopLevelAsk = Number.isFinite(askingUsd) && askingUsd > 0;
  const accepts = Array.isArray(body.accepts) ? body.accepts : [];
  if (!hasTopLevelAsk && accepts.length === 0) return null;
  return {
    asking_usd: hasTopLevelAsk ? askingUsd : null,
    asking_atomic: body.asking_atomic_usdc_base || body.amount_atomic || null,
    pay_to: body.pay_to || body.recipient || null,
    description: body.description || body.product || '',
    accepts,
    reason: body.reason || null,
    floor_usd: Number.isFinite(Number(body.floor_usd)) ? Number(body.floor_usd) : null,
    raw: body,
  };
}

function recordAccepts({ target_url, accepts, ts }) {
  if (!Array.isArray(accepts)) return;
  for (const a of accepts) {
    if (!a || typeof a !== 'object') continue;
    const capability = a.capability || a.name || a.product;
    const ask = Number(a.asking_usd ?? a.amount_usd ?? a.price_usd);
    if (!capability || !Number.isFinite(ask) || ask <= 0) continue;
    recordDiscoveredCapability({ capability, target_url, asking_usd: ask, observed_at: ts });
  }
}

async function emitAuctionCalibration({ capability, target_url, their_asking_usd, their_floor_usd, observed_at }) {
  try {
    const payload = {
      source: 'hive-mcp-barter',
      capability,
      target_url,
      their_asking_usd,
      their_floor_usd,
      observed_at,
    };
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'user-agent': 'hive-mcp-barter/1.0' };
    const hmacKey = process.env.AUCTION_HMAC_KEY;
    if (hmacKey) {
      const sig = createHmac('sha256', hmacKey).update(body).digest('hex');
      headers['x-hive-signature'] = `sha256=${sig}`;
    }
    await fetch(AUCTION_HOOK_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn('auction calibration ping failed (non-fatal):', err?.message || err);
  }
}

export async function probe(target_url) {
  const ts = new Date().toISOString();
  try {
    const res = await fetch(target_url, {
      method: 'POST',
      headers: { ...attributionHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'quote',
        x402_version: 1,
        attribution: { agent: 'hive-mcp-barter' },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    let body = null;
    try { body = await res.json(); } catch { body = null; }

    const envelope = parse402Envelope(body);
    const description = envelope?.description || (typeof body?.description === 'string' ? body.description : '');
    const category = classifyAsk(description);

    recordProbe({
      target_url,
      ts,
      asking_usd: envelope?.asking_usd ?? null,
      category,
      response_code: res.status,
      raw_envelope: envelope?.raw ?? body,
    });

    if (envelope?.accepts?.length) {
      recordAccepts({ target_url, accepts: envelope.accepts, ts });
    }

    if (envelope?.reason === 'below_floor' && Number.isFinite(envelope.floor_usd) && envelope.floor_usd > 0) {
      await emitAuctionCalibration({
        capability: category || description || 'unknown',
        target_url,
        their_asking_usd: envelope.asking_usd,
        their_floor_usd: envelope.floor_usd,
        observed_at: ts,
      });
    }

    return {
      target_url,
      ts,
      response_code: res.status,
      asking_usd: envelope?.asking_usd ?? null,
      asking_atomic: envelope?.asking_atomic ?? null,
      pay_to: envelope?.pay_to ?? null,
      category,
      description,
      accepts: envelope?.accepts ?? [],
      reason: envelope?.reason ?? null,
      floor_usd: envelope?.floor_usd ?? null,
      ok: !!envelope && envelope.asking_usd != null,
    };
  } catch (err) {
    recordProbe({
      target_url,
      ts,
      asking_usd: null,
      category: null,
      response_code: null,
      raw_envelope: { error: String(err?.message || err) },
    });
    return { target_url, ts, response_code: null, ok: false, error: String(err?.message || err) };
  }
}

export async function quoteCurve(target_url, n_probes = 3) {
  const out = [];
  for (let i = 0; i < Math.max(1, Math.min(5, n_probes)); i++) {
    const r = await probe(target_url);
    out.push(r);
    if (!r.ok) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const asks = out.map(r => r.asking_usd).filter(x => Number.isFinite(x));
  const reservation = asks.length ? Math.min(...asks) : null;
  return { target_url, samples: out, reservation_price_usd: reservation };
}
