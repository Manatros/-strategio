import { valueNoise2DAt } from "./noise.js";
import { RNG } from "./rng.js";

function hashCoord(q, r, seed) {
  let h = (q * 374761393) ^ (r * 668265263) ^ (seed * 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  return h || 1;
}

/**
 * The authoritative world. Every room owns exactly one of these. Terrain is
 * generated the first time a tile is asked for and cached forever after —
 * this is what lets mutations (a depleted resource, a built bridge) persist
 * and be consistent for every player in the room.
 */
export class TileStore {
  constructor(seed, hexSize) {
    this.seed = seed;
    this.hexSize = hexSize;
    this.cache = new Map();
  }

  getAt(q, r) { return this.get(`${q},${r}`); }

  get(key) {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const sep = key.indexOf(",");
    const q = Number(key.slice(0, sep));
    const r = Number(key.slice(sep + 1));
    const tile = this.generate(q, r);
    this.cache.set(key, tile);
    return tile;
  }

  generate(q, r) {
    // Same pixel-space sampling the original client-side generator used, so
    // a given seed produces the same-looking world.
    const x = this.hexSize * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
    const y = this.hexSize * (1.5 * r);
    const e = valueNoise2DAt(x, y, 32, this.seed);
    const m = valueNoise2DAt(x, y, 48, this.seed ^ 0xdead);

    let kind = "Grass";
    if (e < 0.34) kind = "Water";
    else if (e < 0.39 && m > 0.55) kind = "Fields";
    else if (e > 0.92) kind = "HighMountain";
    else if (e > 0.78) kind = "Stone";
    else if (m > 0.68) kind = "Forest";
    else if (e < 0.36 && m < 0.3) kind = "Snow";

    let resLeft;
    let maxResLeft;
    const hasResource = kind === "Water" || kind === "Forest" || kind === "Stone" || kind === "Fields" || kind === "HighMountain";
    if (hasResource) {
      const resRng = new RNG(hashCoord(q, r, this.seed));
      resLeft = 20 + ((resRng.next() * 80) | 0);
      maxResLeft = resLeft; // regeneration ceiling — the tile's original endowment when first generated
      if (kind === "Water" && resLeft < 25) kind = "Bridge";
    }

    return { q, r, kind, elev: e, resLeft, maxResLeft };
  }
}