export const emptyBank = () => ({ Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 });

export function canAfford(bank, cost) {
  for (const k of Object.keys(cost)) {
    if ((bank[k] ?? 0) < (cost[k] ?? 0)) return false;
  }
  return true;
}

export function spend(bank, cost) {
  for (const k of Object.keys(cost)) bank[k] -= cost[k] ?? 0;
}

export function add(bank, amounts) {
  for (const k of Object.keys(amounts)) bank[k] = (bank[k] ?? 0) + (amounts[k] ?? 0);
}