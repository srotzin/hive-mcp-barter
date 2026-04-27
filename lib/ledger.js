/**
 * SQLite ledger at /tmp/barter.db.
 *
 * Tables: targets, probes, counters, settlements, blacklist.
 * /tmp survives Render restart for the lifetime of the instance — daily
 * rollups are pushed to hivemorph at midnight ET so a cold start never loses
 * realized P&L history.
 */

import Database from 'better-sqlite3';

const DB_PATH = process.env.BARTER_DB || '/tmp/barter.db';

let db;
export function openDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      target_url TEXT PRIMARY KEY,
      registry TEXT,
      first_seen TEXT,
      last_seen TEXT,
      last_asking_usd REAL,
      last_category TEXT
    );
    CREATE TABLE IF NOT EXISTS probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_url TEXT,
      ts TEXT,
      asking_usd REAL,
      category TEXT,
      response_code INTEGER,
      raw_envelope TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_probes_target_ts ON probes(target_url, ts);
    CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_url TEXT,
      ts TEXT,
      asking_seen_usd REAL,
      offer_usd REAL,
      attribution_id TEXT,
      tx_pre_signed TEXT,
      target_response TEXT,
      accepted INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_counters_ts ON counters(ts);
    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      counter_id INTEGER,
      target_url TEXT,
      ts TEXT,
      paid_usd REAL,
      tx_hash TEXT,
      receipt TEXT,
      resale_value_usd REAL,
      realized_spread_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_settlements_ts ON settlements(ts);
    CREATE TABLE IF NOT EXISTS blacklist (
      target_url TEXT PRIMARY KEY,
      reason TEXT,
      until_ts TEXT,
      strikes INTEGER
    );
    CREATE TABLE IF NOT EXISTS discovered_capabilities (
      capability TEXT NOT NULL,
      target_url TEXT NOT NULL,
      asking_usd REAL NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (capability, target_url, observed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_discovered_capability ON discovered_capabilities(capability);
  `);
  return db;
}

export function recordDiscoveredCapability({ capability, target_url, asking_usd, observed_at }) {
  if (!capability || !target_url || !Number.isFinite(asking_usd)) return;
  const d = openDb();
  d.prepare(`
    INSERT OR IGNORE INTO discovered_capabilities (capability, target_url, asking_usd, observed_at)
    VALUES (?, ?, ?, ?)
  `).run(capability, target_url, asking_usd, observed_at || new Date().toISOString());
}

export function aggregatedCapabilities() {
  const d = openDb();
  const rows = d.prepare(`
    SELECT capability,
           COUNT(*) AS times_observed,
           COUNT(DISTINCT target_url) AS target_count,
           MIN(asking_usd) AS asking_usd_min,
           MAX(asking_usd) AS asking_usd_max
    FROM discovered_capabilities
    GROUP BY capability
    ORDER BY times_observed DESC
  `).all();
  return rows.map(r => {
    const samples = d.prepare(`SELECT asking_usd FROM discovered_capabilities WHERE capability = ? ORDER BY asking_usd`).all(r.capability);
    let p50 = null;
    if (samples.length) {
      const mid = Math.floor(samples.length / 2);
      p50 = samples.length % 2 === 1
        ? samples[mid].asking_usd
        : (samples[mid - 1].asking_usd + samples[mid].asking_usd) / 2;
    }
    return {
      capability: r.capability,
      times_observed: r.times_observed,
      target_count: r.target_count,
      asking_usd_min: r.asking_usd_min,
      asking_usd_max: r.asking_usd_max,
      asking_usd_p50: p50,
    };
  });
}

export function recordTarget({ target_url, registry, asking_usd, category }) {
  const d = openDb();
  const now = new Date().toISOString();
  d.prepare(`
    INSERT INTO targets (target_url, registry, first_seen, last_seen, last_asking_usd, last_category)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_url) DO UPDATE SET
      last_seen = excluded.last_seen,
      last_asking_usd = COALESCE(excluded.last_asking_usd, targets.last_asking_usd),
      last_category = COALESCE(excluded.last_category, targets.last_category)
  `).run(target_url, registry || null, now, now, asking_usd ?? null, category || null);
}

export function recordProbe(p) {
  const d = openDb();
  d.prepare(`
    INSERT INTO probes (target_url, ts, asking_usd, category, response_code, raw_envelope)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    p.target_url,
    p.ts || new Date().toISOString(),
    p.asking_usd ?? null,
    p.category || null,
    p.response_code ?? null,
    p.raw_envelope ? JSON.stringify(p.raw_envelope).slice(0, 4096) : null
  );
}

export function recordCounter(c) {
  const d = openDb();
  const info = d.prepare(`
    INSERT INTO counters (target_url, ts, asking_seen_usd, offer_usd, attribution_id, tx_pre_signed, target_response, accepted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.target_url,
    c.ts || new Date().toISOString(),
    c.asking_seen_usd ?? null,
    c.offer_usd ?? null,
    c.attribution_id || null,
    c.tx_pre_signed || null,
    c.target_response ? JSON.stringify(c.target_response).slice(0, 4096) : null,
    c.accepted ? 1 : 0
  );
  return info.lastInsertRowid;
}

export function recordSettlement(s) {
  const d = openDb();
  d.prepare(`
    INSERT INTO settlements (counter_id, target_url, ts, paid_usd, tx_hash, receipt, resale_value_usd, realized_spread_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.counter_id ?? null,
    s.target_url,
    s.ts || new Date().toISOString(),
    s.paid_usd ?? null,
    s.tx_hash || null,
    s.receipt ? JSON.stringify(s.receipt).slice(0, 4096) : null,
    s.resale_value_usd ?? null,
    s.realized_spread_usd ?? null
  );
}

export function blacklistTarget(target_url, reason, hours = 24) {
  const d = openDb();
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  d.prepare(`
    INSERT INTO blacklist (target_url, reason, until_ts, strikes)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(target_url) DO UPDATE SET
      reason = excluded.reason,
      until_ts = excluded.until_ts,
      strikes = blacklist.strikes + 1
  `).run(target_url, reason, until);
}

export function isBlacklisted(target_url) {
  const d = openDb();
  const row = d.prepare(`SELECT until_ts, strikes FROM blacklist WHERE target_url = ?`).get(target_url);
  if (!row) return false;
  return new Date(row.until_ts).getTime() > Date.now();
}

export function probedInLast24h(target_url) {
  const d = openDb();
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = d.prepare(`SELECT COUNT(*) AS n FROM probes WHERE target_url = ? AND ts > ?`).get(target_url, cutoff);
  return row?.n || 0;
}

export function distinctTargetsLastHour() {
  const d = openDb();
  const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
  const row = d.prepare(`SELECT COUNT(DISTINCT target_url) AS n FROM probes WHERE ts > ?`).get(cutoff);
  return row?.n || 0;
}

export function todaySpentUsd() {
  const d = openDb();
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  const row = d.prepare(`SELECT COALESCE(SUM(paid_usd), 0) AS s FROM settlements WHERE ts > ?`)
    .get(startOfDay.toISOString());
  return row?.s || 0;
}

export function todayBook() {
  const d = openDb();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const probes = d.prepare(`SELECT COUNT(*) AS n FROM probes WHERE ts > ?`).get(since)?.n || 0;
  const counters_sent = d.prepare(`SELECT COUNT(*) AS n FROM counters WHERE ts > ?`).get(since)?.n || 0;
  const counters_accepted = d.prepare(`SELECT COUNT(*) AS n FROM counters WHERE ts > ? AND accepted = 1`).get(since)?.n || 0;
  const settlements = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(paid_usd), 0) AS spent, COALESCE(SUM(realized_spread_usd), 0) AS spread FROM settlements WHERE ts > ?`).get(since);
  return {
    window: 'last_24h',
    probes_sent: probes,
    counters_sent,
    counters_accepted,
    settlements: settlements?.n || 0,
    spent_usd: Number((settlements?.spent || 0).toFixed(6)),
    realized_spread_usd: Number((settlements?.spread || 0).toFixed(6)),
  };
}

export function recentTargets(limit = 50) {
  const d = openDb();
  return d.prepare(`SELECT target_url, registry, last_seen, last_asking_usd, last_category FROM targets ORDER BY last_seen DESC LIMIT ?`).all(limit);
}
