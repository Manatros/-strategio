// Achievements are entirely data-driven: to add a new one, add an entry
// here — nothing else needs to change. Two kinds:
//
//  - "stat" achievements: fire automatically whenever player.stats[statKey]
//    reaches `threshold` within a single game. Checked generically by
//    checkStatAchievements() below, no per-achievement code needed.
//  - "special" achievements: fire from a specific game event that isn't a
//    simple stat threshold (e.g. winning a match). Granted explicitly by
//    whatever code handles that event, using the achievement's id.
//
// Every achievement is a one-time-per-player unlock, persisted forever
// (see persist/store.js) — never re-granted once already held.
export const ACHIEVEMENTS = {
  first_blood:     { id: "first_blood",     name: "First Blood",     description: "Kill an enemy player for the first time.",          category: "combat",  kind: "stat", statKey: "kills",        threshold: 1 },
  warlord:         { id: "warlord",         name: "Warlord",         description: "Kill 3 enemy players in a single game.",             category: "combat",  kind: "stat", statKey: "kills",        threshold: 3 },
  conqueror:       { id: "conqueror",       name: "Conqueror",       description: "Capture 5 enemy buildings in a single game.",        category: "combat",  kind: "stat", statKey: "captured",     threshold: 5 },
  destroyer:       { id: "destroyer",       name: "Destroyer",       description: "Destroy 3 enemy Town Halls in a single game.",       category: "combat",  kind: "stat", statKey: "destroyed",    threshold: 3 },
  master_builder:  { id: "master_builder",  name: "Master Builder",  description: "Construct 20 buildings in a single game.",           category: "economy", kind: "stat", statKey: "built",        threshold: 20 },
  hoarder:         { id: "hoarder",         name: "Hoarder",         description: "Gather 500 total resources in a single game.",       category: "economy", kind: "stat", statKey: "gathered",     threshold: 500 },
  landlord:        { id: "landlord",        name: "Landlord",        description: "Claim 100 tiles of territory in a single game.",     category: "economy", kind: "stat", statKey: "landClaimed",  threshold: 100 },

  // Race trophies: one per race, granted on winning a Domination Victory playing as that race.
  win_human:  { id: "win_human",  name: "Human Conqueror",  description: "Win a game by Domination Victory as Human.",  category: "trophy", kind: "special", race: "Human" },
  win_orc:    { id: "win_orc",    name: "Orc Warchief",     description: "Win a game by Domination Victory as Orc.",    category: "trophy", kind: "special", race: "Orc" },
  win_elf:    { id: "win_elf",    name: "Elf Sovereign",    description: "Win a game by Domination Victory as Elf.",    category: "trophy", kind: "special", race: "Elf" },
  win_dwarf:  { id: "win_dwarf",  name: "Dwarf High King",  description: "Win a game by Domination Victory as Dwarf.",  category: "trophy", kind: "special", race: "Dwarf" },
  win_undead: { id: "win_undead", name: "Undead Lich",      description: "Win a game by Domination Victory as Undead.", category: "trophy", kind: "special", race: "Undead" },
};

export const RACE_TROPHY_ID = { Human: "win_human", Orc: "win_orc", Elf: "win_elf", Dwarf: "win_dwarf", Undead: "win_undead" };

export const STAT_ACHIEVEMENTS = Object.values(ACHIEVEMENTS).filter(a => a.kind === "stat");
