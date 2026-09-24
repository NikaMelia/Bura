import { ALL_CARDS, Card, cardsOf, popcount, rankOf, suitMask, suitOf } from './cards';

export interface Rules {
  /** Highest stake a raise may reach. */
  maxStake: number;
  /** The defender may propose a raise after seeing the lead. */
  defenderMayRaise: boolean;
  /** Three trumps in hand (ბურა) wins the hand immediately. */
  buraWins: boolean;
  /** Match length in points (first to reach it wins the match); 0 means hands are scored without a limit. */
  matchTo: number;
}

export const DEFAULT_RULES: Rules = { maxStake: 8, defenderMayRaise: true, buraWins: false, matchTo: 0 };

/** Match score before a hand, indexed by seat. */
export type MatchScore = [number, number];

/** In a match to N, a player at 0 while the opponent is one point from winning (2-0 in a match to 3) may not raise. */
export function raiseBlockedByScore(rules: Rules, score: MatchScore, p: number): boolean {
  return rules.matchTo > 0 && score[p] === 0 && score[1 - p] === rules.matchTo - 1;
}

/** Does card `a` beat card `b`? */
export function beats(a: Card, b: Card, trump: number): boolean {
  const sa = suitOf(a), sb = suitOf(b);
  if (sa === sb) return rankOf(a) > rankOf(b);
  return sa === trump;
}

/** Mask of every card that would beat `c`. */
export function beatersOf(c: Card, trump: number): number {
  const s = suitOf(c);
  const higherSameSuit = (suitMask(s) >>> 0) & ~((1 << (c + 1)) - 1);
  return (higherSameSuit | (s === trump ? 0 : suitMask(trump))) & ALL_CARDS;
}

/** Can the defender cards beat the led cards one-to-one? Both lists have the same length (1..3). */
export function canBeatAll(defender: Card[], led: Card[], trump: number): boolean {
  const n = led.length;
  if (defender.length !== n) return false;
  if (n === 1) return beats(defender[0], led[0], trump);
  const [a, b, c] = defender;
  const [x, y, z] = led;
  if (n === 2) return (beats(a, x, trump) && beats(b, y, trump)) || (beats(a, y, trump) && beats(b, x, trump));
  return (
    (beats(a, x, trump) && ((beats(b, y, trump) && beats(c, z, trump)) || (beats(b, z, trump) && beats(c, y, trump)))) ||
    (beats(a, y, trump) && ((beats(b, x, trump) && beats(c, z, trump)) || (beats(b, z, trump) && beats(c, x, trump)))) ||
    (beats(a, z, trump) && ((beats(b, x, trump) && beats(c, y, trump)) || (beats(b, y, trump) && beats(c, x, trump))))
  );
}

/** A lead is 1..3 cards of one suit. */
export function isLegalLead(hand: number, lead: number): boolean {
  if (lead === 0 || (lead & ~hand) !== 0) return false;
  const s = suitOf(31 - Math.clz32(lead));
  return (lead & ~suitMask(s)) === 0 && popcount(lead) <= 3;
}

export function leadOptions(hand: number, out: number[] = []): number[] {
  for (let s = 0; s < 4; s++) {
    const sub = hand & suitMask(s);
    for (let m = sub; m; m = (m - 1) & sub) out.push(m);
  }
  return out;
}

export function beatOptions(hand: number, lead: number, trump: number, out: number[] = []): number[] {
  const n = popcount(lead);
  const led = cardsOf(lead);
  for (let m = hand; m; m = (m - 1) & hand) {
    if (popcount(m) === n && canBeatAll(cardsOf(m), led, trump)) out.push(m);
  }
  return out;
}

export function giveOptions(hand: number, n: number, out: number[] = []): number[] {
  for (let m = hand; m; m = (m - 1) & hand) if (popcount(m) === n) out.push(m);
  return out;
}
