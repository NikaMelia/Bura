import { Card, cardsOf, maskOf, popcount } from '../core/cards';
import { Rng } from '../core/rng';
import { GameState, K_BEAT, K_GIVE, K_LEAD, mkAct, K_CLAIM, K_CONTINUE, K_RAISE, K_ACCEPT, K_DECLINE } from '../core/state';
import { Obs, PlayerView } from '../core/view';
import { actionProbability } from './heuristic';

export interface World {
  state: GameState;
  weight: number;
}

export interface BeliefOptions {
  /** Weight each world by how likely the opponent's actual past choices were in it. */
  inference: boolean;
  /** Softmax temperature of the opponent model, in heuristic points. */
  temperature: number;
  /** Share of the opponent model that is uniform random (robustness against unusual opponents). */
  uniformMix: number;
}

export const DEFAULT_BELIEF: BeliefOptions = { inference: true, temperature: 4, uniformMix: 0.15 };

const KIND: Record<string, number> = {
  lead: K_LEAD, beat: K_BEAT, give: K_GIVE, claim: K_CLAIM, continue: K_CONTINUE,
  raise: K_RAISE, accept: K_ACCEPT, decline: K_DECLINE,
};

function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomBit(mask: number, rng: Rng): Card {
  const cards = cardsOf(mask);
  return cards[Math.floor(rng() * cards.length)];
}

/**
 * Samples complete hands consistent with everything `view` has observed: the opponent's hand, the stock order,
 * the cards given to me face down, and the whole history of who drew and gave what. Each world is replayed from
 * the deal with the real sequence of actions, which produces an exact engine state and, when inference is on,
 * an importance weight: the probability that the opponent model would have made the opponent's actual choices.
 */
export function sampleWorlds(view: PlayerView, count: number, rng: Rng, opts: BeliefOptions = DEFAULT_BELIEF): World[] {
  const hist = view.history;
  const deal = hist[0];
  if (!deal || deal.t !== 'deal') throw new Error('No deal in history');
  const me = view.me, opp = 1 - me;
  const unknown = cardsOf(view.unknownMask());
  const hiddenCount = view.myHiddenCount;
  const oppUnknown = view.oppCount - popcount(view.oppKnown);
  const stockUnknown = view.stockCount - (view.trumpInStock ? 1 : 0);
  if (hiddenCount + oppUnknown + stockUnknown !== unknown.length) {
    throw new Error(`Inconsistent view: ${unknown.length} unknown cards for ${hiddenCount}+${oppUnknown}+${stockUnknown} slots`);
  }
  const trumpBit = 1 << view.trumpCard;
  const myInitial = deal.hand;

  const worlds: World[] = [];
  let attempts = 0;
  while (worlds.length < count && attempts < count * 30) {
    attempts++;
    shuffle(unknown, rng);
    const pool = unknown.slice(0, hiddenCount);
    let h = maskOf(unknown.slice(hiddenCount, hiddenCount + oppUnknown)) | view.oppKnown;
    const stockRest = unknown.slice(hiddenCount + oppUnknown);

    // Walk the history backwards to rebuild the opponent's hand over time.
    const giveAssign = new Map<number, number>();
    const drawAssign = new Map<number, Card>();
    let ok = true;
    for (let i = hist.length - 1; i >= 1 && ok; i--) {
      const o = hist[i];
      if (!('p' in o) || o.p !== opp) continue;
      if (o.t === 'lead' || o.t === 'beat') {
        h |= maskOf(o.cards);
      } else if (o.t === 'give') {
        let m = 0;
        for (let k = 0; k < o.count; k++) {
          const j = Math.floor(rng() * pool.length);
          m |= 1 << pool[j];
          pool.splice(j, 1);
        }
        giveAssign.set(i, m);
        h |= m;
      } else if (o.t === 'draw') {
        if (o.card !== undefined) {
          if (!(h & (1 << o.card))) ok = false;
          h &= ~(1 << o.card);
        } else {
          const candidates = h & ~trumpBit;
          if (!candidates) {
            ok = false;
            break;
          }
          const c = randomBit(candidates, rng);
          drawAssign.set(i, c);
          h &= ~(1 << c);
        }
      }
    }
    if (!ok || popcount(h) !== 3 || pool.length !== 0) continue;

    const oppInitial = cardsOf(h);
    const deck: Card[] = [];
    for (let i = 0; i < 3; i++) {
      const first = deal.leader === me ? myInitial : oppInitial;
      const second = deal.leader === me ? oppInitial : myInitial;
      deck.push(first[i], second[i]);
    }
    deck.push(view.trumpCard);
    for (let i = 1; i < hist.length; i++) {
      const o = hist[i];
      if (o.t !== 'draw') continue;
      const c = o.card ?? drawAssign.get(i)!;
      if (c !== view.trumpCard) deck.push(c);
    }
    deck.push(...shuffle(stockRest, rng));

    const replayed = replay(view, hist, deck, giveAssign, opts);
    if (replayed) worlds.push(replayed);
  }
  if (worlds.length === 0) throw new Error('Could not build any world consistent with the history');
  return worlds;
}

function replay(view: PlayerView, hist: Obs[], deck: Card[], giveAssign: Map<number, number>, opts: BeliefOptions): World | null {
  const deal = hist[0] as Extract<Obs, { t: 'deal' }>;
  const s = GameState.deal(deck, deal.leader, deal.rules);
  const opp = 1 - view.me;
  let weight = 1;
  for (let i = 1; i < hist.length; i++) {
    const o = hist[i];
    if (o.t === 'draw' || o.t === 'end') continue;
    if (s.over) return null;
    let mask = 0;
    if (o.t === 'lead' || o.t === 'beat') mask = maskOf(o.cards);
    else if (o.t === 'give') mask = o.p === view.me ? maskOf(o.cards!) : giveAssign.get(i)!;
    const a = mkAct(KIND[o.t], mask);
    if (opts.inference && o.t !== 'deal' && o.p === opp && (o.t === 'lead' || o.t === 'beat' || o.t === 'give')) {
      weight *= actionProbability(s, a, opts.temperature, opts.uniformMix);
    }
    s.apply(a);
  }
  if (s.over && !view.over) return null;
  return { state: s, weight };
}

export function effectiveSampleSize(worlds: World[]): number {
  let sum = 0, sq = 0;
  for (const w of worlds) {
    sum += w.weight;
    sq += w.weight * w.weight;
  }
  return sq === 0 ? 0 : (sum * sum) / sq;
}
