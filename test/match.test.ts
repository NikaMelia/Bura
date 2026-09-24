import { describe, expect, it } from 'vitest';
import { analyze } from '../src/ai/advisor';
import { acceptThreshold, matchEquity, pointsContext, shouldRaise } from '../src/ai/stake';
import { DEFAULT_RULES } from '../src/core/rules';
import { seededRng } from '../src/core/rng';
import { GameState, K_LEAD, mkAct, RAISE, shuffledDeck } from '../src/core/state';
import { HandRunner, PlayerView } from '../src/core/view';
import { m, makeDeck } from './helpers';

const MATCH3 = { ...DEFAULT_RULES, matchTo: 3 };

describe('first-to-3 mode', () => {
  it('forbids raising for the player trailing 0-2, on lead and on defence', () => {
    const deck = makeDeck('As Ks Qh', 'Js Jh 10h', 'Jd');
    // Player 0 leads, trails 0-2.
    const s = GameState.deal(deck, 0, MATCH3, [0, 2]);
    expect(s.legal()).not.toContain(RAISE);
    s.apply(mkAct(K_LEAD, m('As')));
    expect(s.legal()).toContain(RAISE); // the leader of the match may still raise
    // Player 1 defends while trailing 0-2.
    const t = GameState.deal(deck, 0, MATCH3, [2, 0]);
    expect(t.legal()).toContain(RAISE);
    t.apply(mkAct(K_LEAD, m('As')));
    expect(t.legal()).not.toContain(RAISE);
  });

  it('allows raising at every other score and in points mode', () => {
    const deck = makeDeck('As Ks Qh', 'Js Jh 10h', 'Jd');
    for (const score of [[0, 0], [0, 1], [1, 2], [2, 2], [2, 0]] as [number, number][]) {
      expect(GameState.deal(deck, 0, MATCH3, score).legal()).toContain(RAISE);
    }
    expect(GameState.deal(deck, 0, DEFAULT_RULES, [0, 2]).legal()).toContain(RAISE);
  });

  it('views and the advisor know about the restriction', () => {
    const run = new HandRunner(makeDeck('As Ks Qh', 'Js Jh 10h', 'Jd'), 0, MATCH3, [0, 2]);
    const v = run.view(0);
    expect(v.matchScore).toEqual([0, 2]);
    expect(v.canRaise(0)).toBe(false);
    expect(v.legal()).not.toContain(RAISE);
    expect(() => PlayerView.from(0, [...run.obs[0], { t: 'raise', p: 0 }])).toThrow(/may not raise/);
    const a = analyze(v, { iterations: 200, worlds: 40, seed: 1 });
    expect(a.canRaise).toBe(false);
    expect(a.action).not.toBe(RAISE);
    expect(a.matchWinProb).toBeGreaterThanOrEqual(0);
  });

  it('plays whole matches with the search bots without breaking the rule', () => {
    const rng = seededRng(8);
    const score: [number, number] = [0, 0];
    let leader = 0;
    while (Math.max(...score) < 3) {
      const run = new HandRunner(shuffledDeck(rng), leader, MATCH3, [score[0], score[1]]);
      while (!run.state.over) {
        const p = run.state.toAct;
        const a = analyze(run.view(p), { iterations: 150, worlds: 40, seed: score[0] * 10 + score[1] }).action;
        if (a === RAISE) expect(score[p] === 0 && score[1 - p] === 2).toBe(false);
        run.act(a);
      }
      score[run.state.winner] += run.state.stake;
      leader = 1 - run.state.winner;
    }
    expect(Math.max(...score)).toBeGreaterThanOrEqual(3);
  });
});

describe('match-aware stakes', () => {
  it('match equity for a race to 3', () => {
    expect(matchEquity(0, 0, 3)).toBeCloseTo(0.5);
    expect(matchEquity(2, 0, 3)).toBeCloseTo(0.875);
    expect(matchEquity(1, 2, 3)).toBeCloseTo(0.25);
    expect(matchEquity(3, 2, 3)).toBe(1);
  });

  it('keeps the tuned points-mode thresholds', () => {
    expect(acceptThreshold(pointsContext(1))).toBeCloseTo(0.25 + 0.08);
    expect(acceptThreshold(pointsContext(3))).toBeCloseTo(0.125 + 0.08);
    expect(shouldRaise(0.69, pointsContext(1))).toBe(false);
    expect(shouldRaise(0.71, pointsContext(1))).toBe(true);
  });

  it('never raises when the stake cannot matter and raises when ahead at 0-0', () => {
    const ctx = (myScore: number, oppScore: number, stake = 1) => ({ stake, matchTo: 3, myScore, oppScore });
    // At 2-2 the next hand decides the match whatever the stake.
    expect(shouldRaise(0.95, ctx(2, 2))).toBe(false);
    // Leading 2-0 a raise only helps the opponent.
    expect(shouldRaise(0.9, ctx(2, 0))).toBe(false);
    expect(shouldRaise(0.75, ctx(0, 0))).toBe(true);
    expect(shouldRaise(0.52, ctx(0, 0))).toBe(false);
    // Facing a raise at 1-2 (a loss ends the match either way), accepting costs nothing.
    expect(acceptThreshold(ctx(1, 2))).toBeCloseTo(0.08);
  });
});
