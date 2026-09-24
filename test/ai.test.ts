import { describe, expect, it } from 'vitest';
import { analyze } from '../src/ai/advisor';
import { makeBot } from '../src/ai/bots';
import { probReach } from '../src/ai/heuristic';
import { duplicateMatch } from '../src/ai/match';
import { Solver } from '../src/ai/solver';
import { ALL_CARDS } from '../src/core/cards';
import { DEFAULT_RULES } from '../src/core/rules';
import { seededRng } from '../src/core/rng';
import { ACCEPT, CLAIM, CONTINUE, DECLINE, GameState, K_GIVE, K_LEAD, mkAct, Phase, RAISE, shuffledDeck } from '../src/core/state';
import { HandRunner } from '../src/core/view';
import { m, makeDeck } from './helpers';

const FAST = { iterations: 300, worlds: 60, seed: 1 };

describe('claim probability', () => {
  it('is exact for small cases', () => {
    expect(probReach(31, 0, 0)).toBe(1);
    expect(probReach(30, 0, ALL_CARDS)).toBe(0);
    // 25 known + 3 face-down cards: every card is worth at least 2, so 31 is certain.
    expect(probReach(25, 3, ALL_CARDS)).toBe(1);
    // 20 known + 1 card from {A, J}: 50%.
    expect(probReach(20, 1, m('As Js'))).toBeCloseTo(0.5);
  });
});

describe('advisor decisions', () => {
  it('claims when 31 is certain and continues when it is impossible', () => {
    const deck = makeDeck('As 10s Ks', 'Jh Qh Jd', 'Jc');
    const run = new HandRunner(deck, 0, DEFAULT_RULES);
    run.act(mkAct(K_LEAD, m('As 10s Ks')));
    run.act(mkAct(K_GIVE, m('Jh Qh Jd')));
    const a = analyze(run.view(0), FAST);
    expect(a.search.claimProb).toBe(1);
    expect(a.action).toBe(CLAIM);

    const run2 = new HandRunner(makeDeck('As 10s Kd', 'Jh Qh Jd', 'Jc'), 0, DEFAULT_RULES);
    run2.act(mkAct(K_LEAD, m('As')));
    run2.act(mkAct(K_GIVE, m('Jh')));
    const b = analyze(run2.view(0), FAST);
    expect(b.search.claimProb).toBe(0);
    expect(b.action).toBe(CONTINUE);
  });

  it('always returns a legal move in random positions, for every decision type', () => {
    const rng = seededRng(42);
    const kinds = new Set<string>();
    for (let g = 0; g < 12; g++) {
      const run = new HandRunner(shuffledDeck(rng), g % 2, DEFAULT_RULES);
      while (!run.state.over) {
        const p = run.state.toAct;
        const view = run.view(p);
        const a = analyze(view, { ...FAST, seed: g });
        kinds.add(a.decision);
        expect(view.legal()).toContain(a.action);
        // Mix in random moves so raises and odd positions come up.
        const legal = run.state.legal();
        run.act(rng() < 0.3 ? legal[Math.floor(rng() * legal.length)] : a.action);
      }
    }
    expect(kinds).toContain('lead');
    expect(kinds).toContain('respond');
    expect(kinds).toContain('claim');
  });

  it('declines a raise it is sure to lose and accepts one it is favoured to win', () => {
    // Player 1 leads three high spades and player 0 has nothing to beat them: player 1 will claim 31+.
    const run = new HandRunner(makeDeck('As 10s Ks', 'Jh Qh Jd', 'Jc'), 1, DEFAULT_RULES);
    run.act(RAISE);
    const sure = analyze(run.view(0), FAST);
    expect(sure.decision).toBe('raise-response');
    expect(sure.action).toBe(DECLINE);

    // Player 1 holds the three top trumps against three low cards: a clear favourite.
    const run2 = new HandRunner(makeDeck('Jh Qh Jd', 'Ac 10c Kc', 'Jc'), 0, DEFAULT_RULES);
    run2.act(RAISE);
    const good = analyze(run2.view(1), FAST);
    expect(good.winProb).toBeGreaterThan(0.6);
    expect(good.action).toBe(ACCEPT);
  });

  it('is reproducible with a seed', () => {
    const run = new HandRunner(shuffledDeck(seededRng(9)), 0, DEFAULT_RULES);
    const a = analyze(run.view(0), FAST);
    const b = analyze(run.view(0), FAST);
    expect(a.search.actions).toEqual(b.search.actions);
  });
});

describe('solver', () => {
  it('agrees with brute force on random end positions', () => {
    const rng = seededRng(3);
    const brute = (s: GameState, me: number): number => {
      if (s.over) return s.winner === me ? 1 : 0;
      if (s.phase === Phase.Claim) {
        const t = s.clone();
        t.apply(s.score(s.toAct) >= 31 ? CLAIM : CONTINUE);
        return brute(t, me);
      }
      const vals = s.legal().filter((a) => a !== RAISE).map((a) => {
        const t = s.clone();
        t.apply(a);
        return brute(t, me);
      });
      return s.toAct === me ? Math.max(...vals) : Math.min(...vals);
    };
    let checked = 0;
    for (let g = 0; g < 40; g++) {
      const s = GameState.deal(shuffledDeck(rng), 0, DEFAULT_RULES);
      s.noRaise = true;
      // Play randomly until the stock is nearly gone, then compare.
      while (!s.over && s.stockCount > 4) {
        const acts = s.phase === Phase.Claim ? [CONTINUE] : s.legal();
        s.apply(acts[Math.floor(rng() * acts.length)]);
      }
      if (s.over) continue;
      expect(new Solver(0).solve(s)).toBe(brute(s, 0));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('strength', () => {
  it('the search beats the rule-of-thumb player over duplicate deals', () => {
    const rng = seededRng(2024);
    const deals = Array.from({ length: 60 }, () => shuffledDeck(rng));
    let seed = 1;
    const res = duplicateMatch(
      () => makeBot('ismcts', { iterations: 600, seed: seed++ }),
      () => makeBot('heuristic', { seed: seed++ }),
      deals,
      { ...DEFAULT_RULES, maxStake: 1 },
    );
    expect(res.aPointsPerHand).toBeGreaterThan(0);
  });
});
