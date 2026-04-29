# hive-mcp-barter

**Outbound 402 arbitrage agent — Hive Civilization**

Probes 402-enabled MCP endpoints, counter-offers below asking, and settles when the spread clears our resale floor. Pure protocol — no DMs, no spam. Attribution headers on every request.

> Council provenance: Ad-hoc, user-promoted 2026-04-27 (Tier A position 1).

---

## What this is

`hive-mcp-barter` is a Model Context Protocol server that runs an outbound arbitrage loop on top of the 402 payment surface. It scans public MCP registries for 402-enabled endpoints, probes them with standard quote requests, and — when target_asking × counter_pct still lands below our resale floor — issues a single-shot, pre-signed counter-offer. The target accepts by broadcasting our pre-signed transaction; there is no haggle, no second round, and no human-readable outreach.

- **Protocol:** MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0
- **Transport:** `POST /mcp`
- **Discovery:** `GET /.well-known/mcp.json`
- **Health:** `GET /health`
- **Settlement:** USDC on Base L2 — real rails, no mock, no simulated
- **Brand gold:** Pantone 1245 C / `#C08D23`

## Tools

| Tool | Tier | Description |
|---|---|---|
| `barter_discover` | 0 (free) | List 402-enabled MCP endpoints from a public registry (glama, smithery, mcp.so) with last-seen asking prices. |
| `barter_quote_curve` | 0 (free) | Build a demand curve for a target by sending up to 5 probes at descending floor pcts. Returns the reservation-price estimate. |
| `barter_arbitrage_book` | 0 (free) | Today's P&L: probes sent, counters accepted, USDC realized spread. |

## REST endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/barter/discover` | Scan registries for 402 endpoints. |
| `POST` | `/v1/barter/probe` | Send a 402-style quote request to a target. |
| `POST` | `/v1/barter/counter` | Build a signed counter-offer at the configured floor pct. |
| `POST` | `/v1/barter/settle` | Resolve an accepted counter on-chain and book the spread. |
| `GET` | `/v1/barter/ledger` | Running P&L, attempts, wins, spread. |
| `GET` | `/v1/barter/today` | Today aggregate (Tier 0, free). |
| `GET` | `/health` | Service health. |

## Counter-offer envelope

```json
{
  "x402_version": 1,
  "intent": "counter_offer",
  "originator_did": "did:hive:morph",
  "asking_seen_usd": "0.05",
  "offer_usd": "0.0325",
  "offer_atomic_usdc_base": "32500",
  "tx_pre_signed": "0x...",
  "expires": "2026-04-27T20:30:00Z",
  "attribution": {
    "agent": "hive-mcp-barter",
    "attribution_id": "barter-{uuid}",
    "policy": "single-shot-no-haggle"
  }
}
```

The pre-signed transaction is the entire commitment. The target accepts by broadcasting; we never have to re-sign on accept.

## Resale floor

| Category | Our buy floor | Our resell |
|---|---|---|
| LLM tokens | $0.000020 / token | $0.000040 / token |
| Oracle reads | $0.0008 / read | $0.0015 / read |
| Storage writes | $0.00012 / write | $0.00025 / write |
| KYC checks | $0.04 / check | $0.08 / check |

If `target_asking × counter_pct ≤ our_resell × 0.95`, we counter. Otherwise we skip — there is no margin.

## Risk controls

| Cap | Value |
|---|---|
| Max single counter | $0.50 USDC |
| Max daily outbound spend | $25 USDC |
| Max probes per target / 24h | 1 |
| Max distinct targets / hr | 30 |
| Per-target blacklist | 3+ no-response |

All caps fail-closed. Configurable via env vars; missing or invalid env always falls back to the stricter default.

## Configuration

| Env | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | |
| `ENABLE_OUTBOUND` | no | `false` | Default-off. The 5-min cron loop only runs when set to `true`. |
| `WALLET_ADDRESS` | no | `0x15184…436e` | W1 MONROE on Base. |
| `USDC_BASE` | no | `0x833589…2913` | USDC contract on Base. |
| `BASE_RPC` | no | `https://mainnet.base.org` | |
| `HIVECOMPUTE_URL` | no | `https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions` | Used twice daily for resale revaluation. |
| `MAX_DAILY_SPEND_USD` | no | `25` | |
| `MAX_SINGLE_COUNTER_USD` | no | `0.50` | |
| `COUNTER_PCT` | no | `0.65` | |
| `PRIVATE_KEY` | **yes (to sign)** | — | Hex private key for the wallet that funds counter-offers. **Never commit this.** Without it, `/v1/barter/counter` returns an unsigned envelope and the cron loop will not place real bids. |

> Signing is opt-in. The repo does not include a key. To enable real counter-offers, set `PRIVATE_KEY` in the Render dashboard (or your deployment env). To enable the 5-min cron loop, set `ENABLE_OUTBOUND=true`.

## Run locally

```bash
git clone https://github.com/srotzin/hive-mcp-barter.git
cd hive-mcp-barter
npm install
npm start
# server up on http://localhost:3000/mcp
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/mcp.json
curl http://localhost:3000/v1/barter/today
```

## Connect from an MCP client

**Claude Desktop / Cursor / Manus** — add to your `mcp.json`:

```json
{
  "mcpServers": {
    "hive_mcp_barter": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://hive-mcp-barter.onrender.com/mcp"]
    }
  }
}
```

## Hive Civilization

Part of the [Hive Civilization](https://www.thehiveryiq.com) — sovereign DID, USDC settlement, agent-to-agent rails. Companion shims include `hive-mcp-evaluator`, `hive-mcp-compute-grid`, `hive-mcp-depin`, `hive-mcp-agent-storage`, `hive-mcp-agent-kyc`, and `hive-mcp-trade`.

## License

MIT (c) 2026 Steve Rotzin / Hive Civilization

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
