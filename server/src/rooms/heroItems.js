// Hero items: each player's own character has HERO_ITEM_SLOTS equipment slots (see balance.js's
// HERO_ITEMS catalog). Deliberately simple — flat stat bonuses, no rarity/crafting/drops — a
// foundation other hero-unit depth (race-specific items, abilities) can build on later.
import { send } from "../net/wire.js";
import { canAfford } from "../world/economy.js";
import { HERO_ITEMS, HERO_ITEM_SLOTS, PLAYER_MAX_HP } from "../config/balance.js";
import { spendResources, creditResources } from "./humanEconomy.js";

/** Recomputes player.maxHp from PLAYER_MAX_HP plus every equipped item's maxHp bonus, adjusting
 *  current hp by the same delta (gaining an item with +maxHp also heals for that amount; losing
 *  one just clamps hp down to the new max if it would otherwise exceed it). Called after any
 *  equip/unequip — moveSpeedBonus and damageBonus are read directly from equipped items where
 *  needed (stepCooldownFor, combat) rather than cached, since they're situational, not a running total. */
function recomputeHeroMaxHp(player) {
  const oldMax = player.maxHp;
  const bonus = player.heroItems.reduce((sum, itemId) => sum + (itemId ? (HERO_ITEMS[itemId]?.statBonus.maxHp || 0) : 0), 0);
  player.maxHp = PLAYER_MAX_HP + bonus;
  player.hp = Math.max(1, Math.min(player.maxHp, player.hp + (player.maxHp - oldMax)));
}

/** Total moveSpeedBonus (ticks shaved off each step, floored at 1 total) from every equipped item. */
export function heroMoveSpeedBonus(player) {
  if (!player.heroItems) return 0;
  return player.heroItems.reduce((sum, itemId) => sum + (itemId ? (HERO_ITEMS[itemId]?.statBonus.moveSpeedBonus || 0) : 0), 0);
}

/** Total damageBonus from every equipped item — added to the hero's own attack damage, if/when the
 *  hero deals damage directly (as opposed to a trained unit). */
export function heroDamageBonus(player) {
  if (!player.heroItems) return 0;
  return player.heroItems.reduce((sum, itemId) => sum + (itemId ? (HERO_ITEMS[itemId]?.statBonus.damageBonus || 0) : 0), 0);
}

export function handleEquipHeroItem(room, player, msg) {
  const ws = room.clients.get(player.id);
  const slot = Number(msg.slot);
  const itemId = msg.itemId;
  if (!Number.isInteger(slot) || slot < 0 || slot >= HERO_ITEM_SLOTS) return;
  const item = HERO_ITEMS[itemId];
  if (!item) return send(ws, "build_rejected", { reason: "invalid_item" });

  if (!player.heroItems) player.heroItems = new Array(HERO_ITEM_SLOTS).fill(null);
  if (player.heroItems[slot]) return send(ws, "build_rejected", { reason: "slot_occupied" }); // unequip first

  if (!canAfford(player.bank, item.cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });
  spendResources(room, player, item.cost);
  player.heroItems[slot] = itemId;
  recomputeHeroMaxHp(player);
  room._sendBank(ws, player);
}

/** Unequipping refunds the item's full cost — items aren't consumed, just worn or not. */
export function handleUnequipHeroItem(room, player, msg) {
  const ws = room.clients.get(player.id);
  const slot = Number(msg.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= HERO_ITEM_SLOTS) return;
  if (!player.heroItems || !player.heroItems[slot]) return;

  const item = HERO_ITEMS[player.heroItems[slot]];
  player.heroItems[slot] = null;
  recomputeHeroMaxHp(player);
  if (item) creditResources(room, player, item.cost);
  room._sendBank(ws, player);
}