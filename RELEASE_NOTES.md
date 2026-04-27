# hive-mcp-barter v1.0.0

First public release. Outbound 402 arbitrage agent on the Hive Civilization rails.

## Council provenance

Ad-hoc, user-promoted 2026-04-27 (Tier A position 1, ahead of agent-quota). Rationale: outbound revenue creation > inbound metering for the $1000/day target.

## What this is

Shape A only — outbound arbitrage. Scans public 402-enabled MCP registries, sends standard quote probes, counter-offers at a configurable floor pct (default 65%) when target asking still leaves margin against our resale floor, and settles the accepted counters on Base L2 USDC. Single-shot, no-haggle, no DMs, no spam.

## Tools (3)

| Tool | Tier | Description |
|---|---|---|
| `barter_discover` | 0 (free) | List 402-enabled endpoints from glama / smithery / mcp.so. |
| `barter_quote_curve` | 0 (free) | Build a reservation-price estimate via descending probes. |
| `barter_arbitrage_book` | 0 (free) | Today's P&L: probes, accepted counters, realized spread. |

## REST endpoints (7)

`POST /v1/barter/discover` · `POST /v1/barter/probe` · `POST /v1/barter/counter` · `POST /v1/barter/settle` · `GET /v1/barter/ledger` · `GET /v1/barter/today` · `GET /health`

## Risk controls

Max single counter $0.50 USDC. Max daily outbound spend $25 USDC. Max one probe per target per 24h. Max 30 distinct targets per hour. Per-target blacklist after 3+ no-response. All caps fail-closed.

## Defaults

`ENABLE_OUTBOUND=false`. The 5-min cron loop is off by default. Operators flip it to `true` after reviewing the resale floor table and confirming the wallet is funded.

## Wallet

W1 MONROE `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` on Base L2. The repo never carries a private key — `PRIVATE_KEY` is set in the deployment env and only at runtime.

## Backend

Self-contained. The only outbound non-target call is to `https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions` for twice-daily resale revaluation. SQLite ledger at `/tmp/barter.db`.

## Brand

Pantone 1245 C / `#C08D23`.
