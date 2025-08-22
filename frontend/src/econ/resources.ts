// src/econ/resources.ts
export type Resource = "Wood" | "Stone" | "Bread" | "Fish";
export type Bank = Record<Resource, number>;

export const emptyBank = (): Bank => ({ Wood: 0, Stone: 0, Bread: 0, Fish: 0 });

export function canAfford(bank: Bank, cost: Partial<Bank>): boolean {
  for (const k of Object.keys(cost) as Resource[]) {
    if ((bank[k] ?? 0) < (cost[k] ?? 0)) return false;
  }
  return true;
}
export function spend(bank: Bank, cost: Partial<Bank>) {
  for (const k of Object.keys(cost) as Resource[]) {
    bank[k] -= cost[k] ?? 0;
  }
}
export function add(bank: Bank, inc: Partial<Bank>) {
  for (const k of Object.keys(inc) as Resource[]) {
    bank[k] += inc[k] ?? 0;
  }
}
