import { Card, parseCard, parseCards } from '../src/core/cards';
import { DEFAULT_RULES, Rules } from '../src/core/rules';
import { GameState } from '../src/core/state';

/** Deck where the leader gets `leaderHand`, the other player `otherHand`, then `trump`, then `stock` (rest in id order). */
export function makeDeck(leaderHand: string, otherHand: string, trump: string, stock = ''): Card[] {
  const a = parseCards(leaderHand), b = parseCards(otherHand);
  const deck: Card[] = [a[0], b[0], a[1], b[1], a[2], b[2], parseCard(trump), ...parseCards(stock)];
  for (let c = 0; c < 20; c++) if (!deck.includes(c)) deck.push(c);
  return deck;
}

export function makeState(leaderHand: string, otherHand: string, trump: string, stock = '', rules: Partial<Rules> = {}, leader = 0): GameState {
  return GameState.deal(makeDeck(leaderHand, otherHand, trump, stock), leader, { ...DEFAULT_RULES, ...rules });
}

export const m = (text: string): number => parseCards(text).reduce((acc, c) => acc | (1 << c), 0);
