import { Card } from '../core/cards';
import { Rules } from '../core/rules';
import { EndReason } from '../core/state';
import { HandRunner } from '../core/view';
import { Bot } from './bots';

export interface HandOutcome {
  winner: number;
  points: number;
  reason: EndReason;
  moves: number;
}

export function playHand(bots: [Bot, Bot], deck: Card[], leader: number, rules: Rules): HandOutcome {
  const run = new HandRunner(deck, leader, rules);
  let moves = 0;
  while (!run.state.over) {
    const p = run.state.toAct;
    run.act(bots[p].choose(run.view(p)));
    if (++moves > 500) throw new Error('Hand did not finish');
  }
  return { winner: run.state.winner, points: run.state.stake, reason: run.state.reason as EndReason, moves };
}

export interface DuplicateStats {
  deals: number;
  /** Points won minus points lost by A, per hand played. */
  aPointsPerHand: number;
  aHandWinRate: number;
  /** 95% confidence half-width of aPointsPerHand. */
  ci95: number;
  reasons: Record<string, number>;
}

/**
 * Duplicate match: each deal is played twice with the seats swapped, which cancels most of the card luck.
 * A plays seat 0 in the first game of each pair, seat 1 in the second; the leader alternates between deals.
 */
export function duplicateMatch(
  makeA: () => Bot,
  makeB: () => Bot,
  deals: Card[][],
  rules: Rules,
  onProgress?: (done: number, stats: DuplicateStats) => void,
): DuplicateStats {
  const perDeal: number[] = [];
  let wins = 0, hands = 0;
  const reasons: Record<string, number> = {};
  const stats = (): DuplicateStats => {
    const n = perDeal.length;
    const mean = perDeal.reduce((x, y) => x + y, 0) / Math.max(1, n);
    const variance = perDeal.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, n - 1);
    return {
      deals: n,
      aPointsPerHand: mean / 2,
      aHandWinRate: wins / Math.max(1, hands),
      ci95: (1.96 * Math.sqrt(variance / Math.max(1, n))) / 2,
      reasons: { ...reasons },
    };
  };
  deals.forEach((deck, i) => {
    const leader = i % 2;
    let net = 0;
    for (const aSeat of [0, 1]) {
      const a = makeA(), b = makeB();
      const bots: [Bot, Bot] = aSeat === 0 ? [a, b] : [b, a];
      const out = playHand(bots, deck, leader, rules);
      const aWon = out.winner === aSeat;
      net += aWon ? out.points : -out.points;
      if (aWon) wins++;
      hands++;
      reasons[out.reason] = (reasons[out.reason] ?? 0) + 1;
    }
    perDeal.push(net);
    onProgress?.(i + 1, stats());
  });
  return stats();
}
