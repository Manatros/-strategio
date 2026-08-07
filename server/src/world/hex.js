export const key = (q, r) => `${q},${r}`;

export const neighbors = (q, r) => ([
  { q: q + 1, r },
  { q: q + 1, r: r - 1 },
  { q, r: r - 1 },
  { q: q - 1, r },
  { q: q - 1, r: r + 1 },
  { q, r: r + 1 },
]);

export const hexDistance = (a, b) =>
  (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;

/** All axial coords within `radius` of `center` (a filled hex disk, not just the ring). */
export function diskCoords(center, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const r1 = Math.max(-radius, -dq - radius);
    const r2 = Math.min(radius, -dq + radius);
    for (let dr = r1; dr <= r2; dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

export const isPassable = (t) => !!t && t.kind !== "Water" && t.kind !== "Snow" && t.kind !== "HighMountain";

/** Same as isPassable, but lets a caller allow HighMountain through (Dwarf Scouts can cross it). */
export function canEnterTerrain(t, allowHighMountain = false) {
  if (!t) return false;
  if (t.kind === "Water" || t.kind === "Snow") return false;
  if (t.kind === "HighMountain") return allowHighMountain;
  return true;
}