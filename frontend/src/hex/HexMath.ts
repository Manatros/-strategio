// src/hex/HexMath.ts
import type { Axial } from "./types";

/** axial (q,r) -> pixel (pointy-topped) */
export const axialToPixel = (a: Axial, size: number) => {
  const x = size * (Math.sqrt(3) * a.q + (Math.sqrt(3) / 2) * a.r);
  const y = size * (1.5 * a.r);
  return { x, y };
};

/** pixel -> fractional axial (pointy) */
export const pixelToAxialFractional = (x: number, y: number, size: number): { q: number; r: number } => {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  return { q, r };
};

export const axialRound = (q: number, r: number): Axial => {
  // convert to cube, round, then fix the largest diff
  let x = q;
  let z = r;
  let y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const x_diff = Math.abs(rx - x);
  const y_diff = Math.abs(ry - y);
  const z_diff = Math.abs(rz - z);

  if (x_diff > y_diff && x_diff > z_diff) {
    rx = -ry - rz;
  } else if (y_diff > z_diff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return { q: rx, r: rz };
};

export const pixelToAxial = (x: number, y: number, size: number): Axial => {
  const f = pixelToAxialFractional(x, y, size);
  return axialRound(f.q, f.r);
};

export const neighbors = (a: Axial): Axial[] => ([
  { q: a.q + 1, r: a.r     },
  { q: a.q + 1, r: a.r - 1 },
  { q: a.q    , r: a.r - 1 },
  { q: a.q - 1, r: a.r     },
  { q: a.q - 1, r: a.r + 1 },
  { q: a.q    , r: a.r + 1 },
]);

export const hexDistance = (a: Axial, b: Axial) =>
  (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
