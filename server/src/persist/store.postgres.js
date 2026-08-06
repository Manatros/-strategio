// PostgreSQL backend for player persistence — used automatically whenever
// DATABASE_URL is set. This is the path to real horizontal scale: unlike
// the SQLite backend, any number of game-server processes can point at the
// same Postgres instance and share one consistent view of every player's
// identity, entitlements, and leaderboard standing. Point it at a managed
// Postgres (RDS, Supabase, Neon, Render, etc.) and it scales with however
// much you provision there — this code doesn't need to change either way.
//
// Security notes:
//  - Every query is parameterized ($1, $2, ...) — no string-built SQL
//    anywhere, so there's no SQL-injection surface from player-controlled
//    input (names, tokens, etc).
//  - DATABASE_URL (which can contain a password) is read only from the
//    environment and is NEVER logged, anywhere, including on connection
//    errors — only the fact that a connection failed is logged, not the
//    connection string itself.
//  - This game has no username/password login at all (identity is an
//    opaque token or a Steam-verified id) — there is no password to store
//    or leak in the first place. The only personal-ish data kept is a
//    display name the player chose themselves.
import pg from "pg";
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  max: Number(process.env.DATABASE_POOL_MAX) || 20, // cap concurrent connections so a traffic spike can't exhaust the DB
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Managed Postgres providers typically require SSL but use certs that
  // don't chain to a standard root store; this is the common pragmatic
  // setting for that. Self-hosted Postgres without SSL configured is
  // unaffected (ssl stays undefined) unless PGSSL=require is set.
  ssl: /sslmode=require/.test(connectionString || "") || process.env.PGSSL === "require"
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on("error", (err) => {
  // A background/idle client error — never log `err` wholesale if it might echo the connection string back.
  console.error("[store:postgres] unexpected pool error:", err.message);
});

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        token TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Player',
        tag TEXT,
        color BIGINT NOT NULL DEFAULT 3830271,
        best_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        games_played INTEGER NOT NULL DEFAULT 0,
        race TEXT,
        stats_json JSONB,
        owned_races_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        purchase_log_json JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
      CREATE INDEX IF NOT EXISTS idx_players_best_score ON players(best_score DESC);
    `);
  }
  return schemaReady;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    name: row.name, tag: row.tag, color: Number(row.color),
    bestScore: row.best_score, gamesPlayed: row.games_played,
    race: row.race, stats: row.stats_json ?? null,
    ownedRaces: row.owned_races_json ?? [],
  };
}

/** Picks a 4-digit discriminator that doesn't collide with another identity currently using the same name. */
async function generateTag(name) {
  const { rows } = await pool.query(
    "SELECT tag FROM players WHERE lower(name) = lower($1) AND tag IS NOT NULL",
    [name]
  );
  const existingTags = new Set(rows.map(r => r.tag));
  let tag, attempts = 0;
  do {
    tag = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  } while (existingTags.has(tag) && attempts < 50);
  return tag;
}

export async function getPlayerRecord(token) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT * FROM players WHERE token = $1", [token]);
  return rowToRecord(rows[0]);
}

export async function upsertIdentity(token, { name, color }) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT name, color, tag FROM players WHERE token = $1", [token]);
  const existing = rows[0];
  const finalName = name ?? existing?.name ?? "Player";
  const finalColor = color ?? (existing ? Number(existing.color) : 0x3a86ff);
  const tag = existing?.tag || await generateTag(finalName);

  await pool.query(
    `INSERT INTO players (token, name, tag, color) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET name = $2, tag = $3, color = $4`,
    [token, finalName, tag, finalColor]
  );
  return getPlayerRecord(token);
}

export async function recordGameEnd(token, finalScore, race, stats) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT best_score, games_played FROM players WHERE token = $1", [token]);
  const existing = rows[0];
  const gamesPlayed = (existing ? existing.games_played : 0) + 1;
  const shouldUpdateBest = !existing || finalScore >= existing.best_score;

  await pool.query(
    `INSERT INTO players (token, name, best_score, games_played, race, stats_json)
     VALUES ($1, 'Player', $2, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE SET
       games_played = $3,
       best_score = CASE WHEN $6 THEN $2 ELSE players.best_score END,
       race        = CASE WHEN $6 THEN $4 ELSE players.race END,
       stats_json  = CASE WHEN $6 THEN $5::jsonb ELSE players.stats_json END`,
    [token, finalScore, gamesPlayed, race, stats ? JSON.stringify(stats) : null, shouldUpdateBest]
  );
}

const FREE_RACES = ["Human", "Orc", "Elf", "Dwarf", "Undead"]; // TEMPORARY: everyone can play every race for now.
// To re-enable monetization later, change this back to just ["Human"] — nothing else changes.

export async function getOwnedRaces(token) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT owned_races_json FROM players WHERE token = $1", [token]);
  const purchased = rows[0]?.owned_races_json ?? [];
  return [...new Set([...FREE_RACES, ...purchased])];
}

export async function grantRaceEntitlement(token, race, source = "unknown") {
  await ensureSchema();
  const { rows } = await pool.query("SELECT owned_races_json, purchase_log_json FROM players WHERE token = $1", [token]);
  const existing = rows[0];
  const owned = new Set(existing?.owned_races_json ?? []);
  if (owned.has(race)) return false;
  owned.add(race);
  const purchaseLog = existing?.purchase_log_json ?? [];
  purchaseLog.push({ race, source, at: Date.now() });

  await pool.query(
    `INSERT INTO players (token, name, owned_races_json, purchase_log_json) VALUES ($1, 'Player', $2::jsonb, $3::jsonb)
     ON CONFLICT (token) DO UPDATE SET owned_races_json = $2::jsonb, purchase_log_json = $3::jsonb`,
    [token, JSON.stringify([...owned]), JSON.stringify(purchaseLog)]
  );
  return true;
}

export async function getHighscores(limit = 50) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT * FROM players ORDER BY best_score DESC LIMIT $1", [limit]);
  return rows.map((row) => ({
    name: row.name, tag: row.tag || null, color: Number(row.color), bestScore: row.best_score, gamesPlayed: row.games_played,
    race: row.race || null, stats: row.stats_json ?? null,
  }));
}

export async function flush() {} // Postgres commits durably per-statement already — kept for interface parity

process.on("exit", () => { pool.end().catch(() => {}); });