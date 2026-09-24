// A card is an integer 0..19: suit * 5 + rank. Sets of cards are 20-bit masks.
export type Card = number;

export const NUM_CARDS = 20;
export const ALL_CARDS = 0xfffff;
export const TARGET = 31;

export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'] as const;
export const SUIT_LETTERS = ['s', 'h', 'd', 'c'] as const;
export const RANK_NAMES = ['J', 'Q', 'K', '10', 'A'] as const;
export const RANK_POINTS = [2, 3, 4, 10, 11] as const;

export const suitOf = (c: Card): number => (c / 5) | 0;
export const rankOf = (c: Card): number => c % 5;
export const pointsOf = (c: Card): number => RANK_POINTS[c % 5];
export const makeCard = (suit: number, rank: number): Card => suit * 5 + rank;
export const suitMask = (suit: number): number => 0x1f << (suit * 5);
export const bit = (c: Card): number => 1 << c;
export const has = (mask: number, c: Card): boolean => (mask & (1 << c)) !== 0;

// Lookup tables over 10 bits. Cards 10..19 repeat the rank pattern of 0..9, so one table serves both halves.
const POP10 = new Uint8Array(1024);
const PTS10 = new Uint8Array(1024);
for (let m = 1; m < 1024; m++) {
  const low = 31 - Math.clz32(m & -m);
  POP10[m] = POP10[m & (m - 1)] + 1;
  PTS10[m] = PTS10[m & (m - 1)] + RANK_POINTS[low % 5];
}

export const popcount = (m: number): number => POP10[m & 1023] + POP10[m >>> 10];
export const maskPoints = (m: number): number => PTS10[m & 1023] + PTS10[m >>> 10];
export const lowestCard = (m: number): Card => 31 - Math.clz32(m & -m);

export function cardsOf(mask: number): Card[] {
  const out: Card[] = [];
  for (let m = mask; m; m &= m - 1) out.push(31 - Math.clz32(m & -m));
  return out;
}

export function maskOf(cards: Iterable<Card>): number {
  let m = 0;
  for (const c of cards) m |= 1 << c;
  return m;
}

export function cardName(c: Card): string {
  return RANK_NAMES[rankOf(c)] + SUIT_SYMBOLS[suitOf(c)];
}

export function maskName(mask: number): string {
  return cardsOf(mask).map(cardName).join(' ');
}

/** Parses "A♠", "As", "10h", "Th", "qd". */
export function parseCard(text: string): Card {
  const t = text.trim();
  const suitChar = t.slice(-1).toLowerCase();
  const rankText = t.slice(0, -1).toUpperCase();
  let suit: number = SUIT_SYMBOLS.indexOf(suitChar as never);
  if (suit < 0) suit = SUIT_LETTERS.indexOf(suitChar as never);
  const rank = rankText === 'T' ? 3 : RANK_NAMES.indexOf(rankText as never);
  if (suit < 0 || rank < 0) throw new Error(`Not a card: "${text}"`);
  return makeCard(suit, rank);
}

export function parseCards(text: string): Card[] {
  return text.split(/[\s,]+/).filter(Boolean).map(parseCard);
}
