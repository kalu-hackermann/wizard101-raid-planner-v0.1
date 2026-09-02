export type School = "Storm" | "Fire" | "Ice" | "Life" | "Death" | "Myth" | "Balance";
export type CardType = "Attack" | "Blade" | "Trap" | "Shield" | "Heal" | "Utility";

export interface Card {
  id: string;
  name: string;
  school: School;
  type: CardType;
  pips: number;
}

export interface Player {
  id: string;
  name: string;
  school: School;
}

export interface Assignment {
  playerId: string;
  cardId: string;
}

export interface Round {
  id: string;
  name: string;
  assignments: Assignment[];
}