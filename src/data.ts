import type { Card, Player, Round } from "./types";

export const schools = ["All", "Storm", "Fire", "Ice", "Life", "Death", "Myth", "Balance"] as const;
export const cardTypes = ["All", "Attack", "Blade", "Trap", "Shield", "Heal", "Utility"] as const;

export const sampleCards: Card[] = [
  { id: "storm-lord", name: "Storm Lord", school: "Storm", type: "Attack", pips: 7 },
  { id: "tempest", name: "Tempest", school: "Storm", type: "Attack", pips: 4 },
  { id: "storm-blade", name: "Stormblade", school: "Storm", type: "Blade", pips: 0 },
  { id: "feint", name: "Feint", school: "Death", type: "Trap", pips: 0 },
  { id: "dark-pact", name: "Dark Pact", school: "Death", type: "Utility", pips: 0 },
  { id: "balanceblade", name: "Balanceblade", school: "Balance", type: "Blade", pips: 0 },
  { id: "elemental-blade", name: "Elemental Blade", school: "Balance", type: "Blade", pips: 0 },
  { id: "fire-blade", name: "Fireblade", school: "Fire", type: "Blade", pips: 0 },
  { id: "fire-dragon", name: "Fire Dragon", school: "Fire", type: "Attack", pips: 7 },
  { id: "tower-shield", name: "Tower Shield", school: "Ice", type: "Shield", pips: 0 },
  { id: "satyr", name: "Satyr", school: "Life", type: "Heal", pips: 4 },
  { id: "myth-trap", name: "Myth Trap", school: "Myth", type: "Trap", pips: 0 }
];

export const starterPlayers: Player[] = [
  { id: "p1", name: "Storm", school: "Storm" },
  { id: "p2", name: "Death", school: "Death" },
  { id: "p3", name: "Balance", school: "Balance" },
  { id: "p4", name: "Support", school: "Life" }
];

export const starterRounds: Round[] = [
  { id: "r1", name: "Round 1", assignments: [] },
  { id: "r2", name: "Round 2", assignments: [] },
  { id: "r3", name: "Round 3", assignments: [] }
];