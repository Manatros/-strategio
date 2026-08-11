// src/core/research.ts
// Mirrors config/balance.js's RESEARCH_OPTIONS on the server, for display
// only — the server validates everything for real when "research" is sent.
export type ResearchOption = {
  id: string;
  name: string;
  cost: Record<string, number>;
  description: string;
};

export const RESEARCH_OPTIONS: Record<string, ResearchOption[]> = {
  Human: [
    { id: "trade_routes", name: "Trade Routes", cost: { Gold: 25 }, description: "+20% gathering from Lumberjacks, Farms, Mines, and Fishing Boats" },
    { id: "masonry", name: "Masonry", cost: { Gold: 25 }, description: "+20% Soldier and Archer health" },
    { id: "census", name: "Census", cost: { Gold: 35 }, description: "+5 population capacity" },
  ],
  Orc: [
    { id: "blood_rage", name: "Blood Rage", cost: { Gold: 25 }, description: "+30% Grunt health" },
    { id: "raiding", name: "Raiding", cost: { Gold: 25 }, description: "+20% gathering from Wood Grunts, Mines, and Fishing Boats" },
    { id: "warband", name: "Warband", cost: { Gold: 35 }, description: "+5 population capacity" },
  ],
  Elf: [
    { id: "elder_wisdom", name: "Elder Wisdom", cost: { Gold: 25 }, description: "+20% gathering from all resource buildings" },
    { id: "woodcraft", name: "Woodcraft", cost: { Gold: 25 }, description: "+30% Forager health" },
    { id: "grove_growth", name: "Grove Growth", cost: { Gold: 35 }, description: "+5 population capacity" },
  ],
  Dwarf: [
    { id: "deep_mining", name: "Deep Mining", cost: { Gold: 20 }, description: "+30% Mine gathering" },
    { id: "runesmithing", name: "Runesmithing", cost: { Gold: 20 }, description: "+20% Warrior and Boomstick health" },
    { id: "mountain_halls", name: "Mountain Halls", cost: { Gold: 30 }, description: "+5 population capacity" },
  ],
  Undead: [
    { id: "necrotic_might", name: "Necrotic Might", cost: { Gold: 25 }, description: "+30% health for all combat units" },
    { id: "soul_harvest", name: "Soul Harvest", cost: { Gold: 25 }, description: "+20% gathering from all resource buildings" },
    { id: "crypt_expansion", name: "Crypt Expansion", cost: { Gold: 35 }, description: "+5 population capacity" },
  ],
};
