// src/core/color.ts
export function toPixiColor(input: string | number | null | undefined, fallback = 0x3a86ff): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (!input) return fallback;

  let s = String(input).trim().toLowerCase();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.startsWith("0x")) s = s.slice(2);

  const n = Number.parseInt(s, 16);
  return Number.isFinite(n) ? n : fallback;
}
