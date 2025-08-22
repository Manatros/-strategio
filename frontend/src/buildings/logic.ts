// src/buildings/logic.ts
import type { Building } from "./types";
import type { MapData, Tile } from "../hex/types";
import { key as tileKey } from "../hex/types";
import type { Bank } from "../econ/resources";

/**
 * Per‑second base rates (units of resource / sec) while tile has resLeft.
 * TownHall: slow AoE gather (self + 6 neighbors at lower rate), per GDD note.  
 */
export const BASE_RATE = {
  Lumberjack: 0.8,  // wood on Forest
  Farm:       0.8,  // bread on Fields
  Mine:       0.6,  // stone on Stone
  FishingBoat:0.7,  // fish on Water
  TownHallSelf:0.15,
  TownHallAdj :0.08,
} as const;

export function gatherTick(map: MapData, b: Building, dtSec: number, bank: Bank) {
  const t = map.tiles.get(tileKey(b.q, b.r));
  if (!t) return;

  const take = (tile: Tile | undefined, kind: "Wood"|"Bread"|"Stone"|"Fish", rate: number) => {
    if (!tile || tile.resLeft === undefined || tile.resLeft <= 0) return;
    const got = Math.min(tile.resLeft, rate * dtSec);
    tile.resLeft -= got;
    bank[kind] += got;
  };

  switch (b.kind) {
    case "Lumberjack":  if (t.kind === "Forest") take(t, "Wood", BASE_RATE.Lumberjack); break;
    case "Farm":        if (t.kind === "Fields") take(t, "Bread", BASE_RATE.Farm); break;
    case "Mine":        if (t.kind === "Stone")  take(t, "Stone", BASE_RATE.Mine); break;
    case "FishingBoat": if (t.kind === "Water")  take(t, "Fish",  BASE_RATE.FishingBoat); break;
    case "Bridge":      /* no gather */ break;
    case "TownHall": {
      // self + neighbors, slow
      if (t.kind === "Forest") take(t, "Wood", BASE_RATE.TownHallSelf);
      if (t.kind === "Fields") take(t, "Bread", BASE_RATE.TownHallSelf);
      if (t.kind === "Stone")  take(t, "Stone", BASE_RATE.TownHallSelf);
      if (t.kind === "Water")  take(t, "Fish",  BASE_RATE.TownHallSelf);
      // neighbors
      const adj = [
        { q: b.q+1, r:b.r }, { q: b.q+1, r:b.r-1 }, { q: b.q, r:b.r-1 },
        { q: b.q-1, r:b.r }, { q: b.q-1, r:b.r+1 }, { q: b.q, r:b.r+1 },
      ];
      for (const a of adj) {
        const nt = map.tiles.get(tileKey(a.q, a.r));
        if (!nt) continue;
        if (nt.kind === "Forest") take(nt, "Wood", BASE_RATE.TownHallAdj);
        if (nt.kind === "Fields") take(nt, "Bread", BASE_RATE.TownHallAdj);
        if (nt.kind === "Stone")  take(nt, "Stone", BASE_RATE.TownHallAdj);
        if (nt.kind === "Water")  take(nt, "Fish",  BASE_RATE.TownHallAdj);
      }
      break;
    }
  }
}
