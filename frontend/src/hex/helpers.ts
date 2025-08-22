// src/hex/helpers.ts
import type { Tile } from "./types";

export const isPassable = (t: Tile | undefined) => {
  if (!t) return false;
  return t.kind !== "Water" && t.kind !== "Snow";
};

// 6 axial directions (matching neighbors order)
export const DIRS = [
  { q: 1, r: 0 },   // 0
  { q: 1, r: -1 },  // 1
  { q: 0, r: -1 },  // 2
  { q: -1, r: 0 },  // 3
  { q: -1, r: 1 },  // 4
  { q: 0, r: 1 },   // 5
];

export const keyFor = (q: number, r: number) => `${q},${r}`;
