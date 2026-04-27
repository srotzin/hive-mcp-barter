/**
 * 402 quote requester.
 *
 * Sends a standard 402 RFQ to a target endpoint and parses the response.
 * Three terminal outcomes:
 *   - 402 envelope returned with x402_version + asking_usd → quoted
 *   - any other 2xx/4xx → recorded as response_code, no quote
 *   - timeout / network error → no_response (caller may blacklist)
 *
 * Polite: 10s hard timeout, attribution headers on every request, never
 * retried within the same probe call.
 */

import { recordProbe } from './ledger.js';
import { classifyAsk } from './valuation.js';

const PROBE_TIMEOUT_MS = 10000;

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
  if (!Number.isFinite(askingUsd) || askingUsd <= 0) return null;
  return {
    asking_usd: askingUsd,
    asking_atomic: body.asking_atomic_usdc_base || body.amount_atomic || null,
    pay_to: body.pay_to || body.recipient || null,
    description: body.description || body.product || '',
    raw: body,
  };
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

    return {
      target_url,
      ts,
      response_code: res.status,
      asking_usd: envelope?.asking_usd ?? null,
      asking_atomic: envelope?.asking_atomic ?? null,
      pay_to: envelope?.pay_to ?? null,
      category,
      description,
      ok: !!envelope,
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
