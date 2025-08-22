import { valueNoise2D } from "../core/valueNoise";
import { RNG } from "../core/rng";
import { key, type MapData, type Tile } from "./types";

export function generateMap(radius:number, hexSize:number, seed=20250822): MapData {
  const rng = new RNG(seed);
  // build a bounding box to sample noise and then filter in-radius
  const diameter = radius*2+1;
  const gridW = diameter*2*hexSize;
  const gridH = diameter*2*hexSize;
  const elev = valueNoise2D(gridW, gridH, 32, seed);
  const moisture = valueNoise2D(gridW, gridH, 48, seed^0xdead);
  const tiles = new Map<string,Tile>();

  // helper to sample [0..1] noise at approximate pixel coords of axial
  const sample = (x:number,y:number,arr:Float32Array)=> {
    const ix = Math.max(0, Math.min(gridW-1, Math.floor(x)));
    const iy = Math.max(0, Math.min(gridH-1, Math.floor(y)));
    return arr[iy*gridW+ix];
  };

  // approximate axial->pixel to sample noise fields
  const toPixel = (q:number,r:number) => {
    const x = hexSize * (Math.sqrt(3) * q + Math.sqrt(3)/2 * r);
    const y = hexSize * (3/2 * r);
    return {x: x + gridW/2, y: y + gridH/2};
  };

  for(let q=-radius;q<=radius;q++){
    for(let r=-radius;r<=radius;r++){
      const s = -q-r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) > radius) continue;
      const {x,y} = toPixel(q,r);
      const e = sample(x,y,elev);
      const m = sample(x,y,moisture);
      let kind: Tile["kind"] = "Grass";
      if (e < 0.34) kind = "Water";
      else if (e < 0.39 && m > 0.55) kind = "Fields";
      else if (e > 0.78) kind = "Stone";
      else if (m > 0.68) kind = "Forest";
      else if (e < 0.36 && m < 0.3) kind = "Snow";
      tiles.set(key(q,r), { q, r, kind, elev: e, resLeft: kind==="Water"||kind==="Forest"||kind==="Stone"||kind==="Fields" ? (20 + (rng.next()*80)|0) : undefined });
    }
  }
  // sprinkle a few bridges across narrow water (placeholder)
  let bridges = 0;
  for (const t of tiles.values()) {
    if (bridges>Math.sqrt(tiles.size)/2) break;
    if (t.kind!=="Water") continue;
    if (t.resLeft && t.resLeft<25) { t.kind="Bridge"; bridges++; }
  }
  return { radius, hexSize, tiles };
}
