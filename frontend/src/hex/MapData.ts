import type { MapData } from "./types";
import { TileStore } from "./TileStore";

/**
 * Builds an infinite hex world: there's no boundary, terrain is generated
 * lazily tile-by-tile as it's requested (see TileStore), so the player can
 * walk in any direction indefinitely.
 */
export function generateMap(hexSize: number, seed = 20250822): MapData {
  return { hexSize, seed, tiles: new TileStore(seed, hexSize) };
}