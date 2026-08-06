// src/core/balance.ts
//
// The server (server/src/config/balance.js) is the only authority on game
// balance — everything here is a client-side *mirror*, used purely for
// instant UI feedback (greying out a button, picking a ghost color) before
// the server's response arrives. If a value here drifts out of sync with
// the server, the worst case is a wrong-looking button for one click; the
// server's own check always has the final say.
import type { BuildingKind } from "../buildings/types";

/** Buildings that don't need an assigned worker — mirrors WORKER_EXEMPT in balance.js. */
export const WORKER_EXEMPT = new Set<BuildingKind>(["TownHall", "House"]);

/** How far each combat unit can attack — mirrors ATTACK_RANGE in balance.js (units only; ArcherTower fires on its own). */
export const ATTACK_RANGE: Record<string, number> = { Soldier: 1, Archer: 3 };