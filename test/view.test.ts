import { describe, expect, it } from 'vitest';
import { ALL_CARDS, maskPoints, popcount } from '../src/core/cards';
import { DEFAULT_RULES } from '../src/core/rules';
import { seededRng } from '../src/core/rng';
import { GameState, Phase, shuffledDeck } from '../src/core/state';
import { HandRunner, PlayerView } from '../src/core/view';
import { sampleWorlds } from '../src/ai/belief';

function randomHand(seed: number, onStep?: (run: HandRunner) => void): HandRunner {
  const rng = seededRng(seed);
  const run = new HandRunner(shuffledDeck(rng), seed % 2, DEFAULT_RULES);
  while (!run.state.over) {
    onStep?.(run);
    const acts = run.state.legal();
    run.act(acts[Math.floor(rng() * acts.length)]);
  }
  return run;
}

function checkView(run: HandRunner, p: number): void {
  const s: GameState = run.state;
  const v: PlayerView = run.view(p);
  const o = 1 - p;
  expect(v.hand).toBe(s.hands[p]);
  expect(v.oppCount).toBe(popcount(s.hands[o]));
  expect(v.stockCount).toBe(s.stockCount);
  expect(v.oppPile).toBe(s.piles[o]);
  expect(v.myPileKnown).toBe(s.piles[p] & ~s.hidden[p]);
  expect(v.myHiddenCount).toBe(popcount(s.hidden[p]));
  expect(v.phase).toBe(s.phase);
  expect(v.toAct).toBe(s.toAct);
  expect(v.stake).toBe(s.stake);
  expect(v.lead).toBe(s.lead);
  if (s.toAct === p) expect(new Set(v.legal())).toEqual(new Set(s.legal()));
  // Every unknown card really is in one of the three places I can't see.
  const unknown = v.unknownMask();
  const trumpBit = s.stockCount > 0 ? 1 << s.trumpCard : 0;
  let stockMask = 0;
  for (let i = s.stockPos; i < s.stock.length; i++) stockMask |= 1 << s.stock[i];
  expect(unknown).toBe((s.hands[o] & ~v.oppKnown) | (stockMask & ~trumpBit) | s.hidden[p]);
  expect(ALL_CARDS & ~unknown).toBe(s.seen[p]);
}

describe('player views', () => {
  it('match the engine state at every step of random hands', () => {
    for (let seed = 1; seed <= 150; seed++) {
      randomHand(seed, (run) => {
        checkView(run, 0);
        checkView(run, 1);
      });
    }
  });

  it('never reveal face-down cards to the player who receives them', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const run = randomHand(seed);
      for (const p of [0, 1]) {
        for (const o of run.obs[p]) {
          if (o.t === 'give' && o.p !== p) expect(o.cards).toBeUndefined();
          if (o.t === 'draw' && o.p !== p && o.card !== undefined) expect(o.card).toBe(run.state.trumpCard);
        }
      }
    }
  });

  it('rebuild identically from the observation list', () => {
    const run = randomHand(7);
    for (const p of [0, 1]) {
      const v = PlayerView.from(p, run.obs[p]);
      expect(v.result).toEqual(run.view(p).result);
    }
  });

  it('reject impossible input', () => {
    const run = new HandRunner(shuffledDeck(seededRng(5)), 0, DEFAULT_RULES);
    const v = run.view(0);
    const notMine = [0, 1, 2, 3, 4, 5].find((c) => !(v.hand & (1 << c)))!;
    expect(() => PlayerView.from(0, [...run.obs[0], { t: 'lead', p: 0, cards: [notMine] }])).toThrow();
    expect(() => PlayerView.from(0, [...run.obs[0], { t: 'lead', p: 1, cards: [0] }])).toThrow(/turn/);
  });
});

describe('determinization', () => {
  it('produces full states consistent with what the player knows, replaying the real history', () => {
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      randomHand(seed, (run) => {
        for (const p of [0, 1]) {
          const v = run.view(p);
          if (v.phase === Phase.Over || v.phase === Phase.Draw) continue;
          const worlds = sampleWorlds(v, 3, seededRng(seed * 7 + p), { inference: true, temperature: 4, uniformMix: 0.15 });
          for (const { state: w, weight } of worlds) {
            expect(weight).toBeGreaterThan(0);
            expect(w.hands[p]).toBe(v.hand);
            expect(popcount(w.hands[1 - p])).toBe(v.oppCount);
            expect(w.hands[1 - p] & v.oppKnown).toBe(v.oppKnown);
            expect(w.piles[1 - p]).toBe(v.oppPile);
            expect(w.piles[p] & ~w.hidden[p]).toBe(v.myPileKnown);
            expect(popcount(w.hidden[p])).toBe(v.myHiddenCount);
            expect(w.stockCount).toBe(v.stockCount);
            expect(w.phase).toBe(v.phase);
            expect(w.toAct).toBe(v.toAct);
            expect(w.stake).toBe(v.stake);
            expect(w.seen[p]).toBe(run.state.seen[p]);
            expect(maskPoints(w.piles[0] | w.piles[1] | w.hands[0] | w.hands[1])).toBeLessThanOrEqual(120);
            checked++;
          }
        }
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
