// Persistence dispatcher: picks a backend based on whether DATABASE_URL is
// set, and re-exports the exact same async interface either way, so
// nothing else in the codebase needs to know or care which one is active.
//
//  - No DATABASE_URL  -> SQLite (store.sqlite.js). Zero setup, one file on
//    disk, perfect for local dev or a small self-hosted deployment.
//  - DATABASE_URL set -> PostgreSQL (store.postgres.js). Any number of
//    game-server processes can point at the same database and share one
//    consistent view of every player — this is the path to real scale.
//
// Switching later is just setting an environment variable — no code or
// call-site changes needed in either direction.
const backend = process.env.DATABASE_URL
  ? await import("./store.postgres.js")
  : await import("./store.sqlite.js");

export const {
  getPlayerRecord,
  upsertIdentity,
  recordGameEnd,
  getOwnedRaces,
  grantRaceEntitlement,
  getPlayerAchievements,
  grantAchievement,
  registerAccount,
  verifyAccountLogin,
  getIsAdmin,
  setAdmin,
  setAdminByNameTag,
  getKeybindings,
  setKeybindings,
  getHighscores,
  flush,
} = backend;
