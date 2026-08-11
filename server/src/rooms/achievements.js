// Achievement checking. Stat-based achievements are checked generically —
// add one to config/achievements.js and it's live everywhere this is
// called, no new code needed. Special (event-driven) achievements are
// granted explicitly by whatever code handles that event (see winConditions.js
// for the race-trophy example), through the same grant() helper.
import { send } from "../net/wire.js";
import { getPlayerAchievements, grantAchievement } from "../persist/store.js";
import { ACHIEVEMENTS, STAT_ACHIEVEMENTS } from "../config/achievements.js";

/** Call once when a player joins, so their in-memory Set reflects what they've already unlocked (lifetime, across games). */
export async function loadAchievements(player) {
  const list = await getPlayerAchievements(player.token);
  player.unlockedAchievements = new Set(list.map(a => a.id));
}

/** Grants one achievement if not already held, persists it, and notifies the player. Safe to call redundantly. */
export function grant(room, player, achievementId) {
  if (!player.unlockedAchievements) player.unlockedAchievements = new Set();
  if (player.unlockedAchievements.has(achievementId)) return;
  const def = ACHIEVEMENTS[achievementId];
  if (!def) return;

  player.unlockedAchievements.add(achievementId); // mark immediately so a burst of stat updates this tick can't double-fire
  grantAchievement(player.token, achievementId)
    .catch((err) => console.error(`[achievements] grant failed for ${player.id}/${achievementId}: ${err.message}`));

  const ws = room.clients.get(player.id);
  if (ws) send(ws, "achievement_unlocked", { id: def.id, name: def.name, description: def.description, category: def.category });
}

/** Checks every stat-threshold achievement against this player's current in-game stats. Call after anything that changes player.stats. */
export function checkStatAchievements(room, player) {
  if (!player.unlockedAchievements) return; // not loaded yet (shouldn't normally happen — join() awaits loadAchievements first)
  for (const def of STAT_ACHIEVEMENTS) {
    if (player.unlockedAchievements.has(def.id)) continue;
    if ((player.stats[def.statKey] ?? 0) >= def.threshold) grant(room, player, def.id);
  }
}
