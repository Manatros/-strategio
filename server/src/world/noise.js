import { RNG } from "./rng.js";

const lerp = (a, b, t) => a + (b - a) * t;
const fade = (t) => t * t * (3 - 2 * t);

function latticeValue(gx, gy, seed) {
  let h = (gx * 374761393) ^ (gy * 668265263) ^ (seed * 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  return new RNG(h || 1).next();
}

/** Samples value noise at any (x,y) — no bounds, safe for an infinite world. */
export function valueNoise2DAt(x, y, scale = 16, seed = 1337) {
  const gx = x / scale, gy = y / scale;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = fade(gx - x0), ty = fade(gy - y0);
  const v00 = latticeValue(x0, y0, seed);
  const v10 = latticeValue(x0 + 1, y0, seed);
  const v01 = latticeValue(x0, y0 + 1, seed);
  const v11 = latticeValue(x0 + 1, y0 + 1, seed);
  const v0 = lerp(v00, v10, tx);
  const v1 = lerp(v01, v11, tx);
  return lerp(v0, v1, ty);
}
