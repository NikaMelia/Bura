import { maskPoints, TARGET } from '../core/cards';
import { CLAIM, CONTINUE, GameState, Phase, RAISE } from '../core/state';
import { scoreActions } from './heuristic';

/**
 * Exact solver for a fully known hand (both hands and the stock order known): does `me` win with best play
 * from both sides? A player claims exactly when its pile is worth 31+, which is optimal with full information.
 * Values are 0/1, so alpha-beta reduces to "stop at the first winning move". A transposition table at trick
 * boundaries makes it fast: the value there depends only on the hands, the stock position, who leads and the
 * score of player 0 (player 1's score follows from the cards already out of play).
 */
export class Solver {
  nodes = 0;
  private tt = new Map<number, number>();
  private scores: number[] = [];

  constructor(readonly me: number) {}

  solve(s: GameState): number {
    this.nodes++;
    if (s.phase === Phase.Over) return s.winner === this.me ? 1 : 0;
    if (s.phase === Phase.Claim) {
      const t = s.clone();
      t.apply(s.score(s.toAct) >= TARGET ? CLAIM : CONTINUE);
      return this.solve(t);
    }
    let key = -1;
    if (s.phase === Phase.Lead) {
      key = ((s.hands[1] * 1048576 + s.hands[0]) * 16 + s.stockPos) * 256 + s.leader * 128 + maskPoints(s.piles[0]);
      const hit = this.tt.get(key);
      if (hit !== undefined) return hit;
    }
    const acts = s.legal().filter((a) => a !== RAISE);
    if (acts.length > 1) this.order(s, acts);
    const maximizing = s.toAct === this.me;
    let result = maximizing ? 0 : 1;
    for (const a of acts) {
      const t = s.clone();
      t.apply(a);
      const v = this.solve(t);
      if (maximizing ? v === 1 : v === 0) {
        result = v;
        break;
      }
    }
    if (key >= 0) this.tt.set(key, result);
    return result;
  }

  /** Try the heuristically best moves first; they are most likely to cut off the search. */
  private order(s: GameState, acts: number[]): void {
    const sc = this.scores;
    sc.length = acts.length;
    scoreActions(s, acts, sc);
    const idx = acts.map((_, i) => i).sort((x, y) => sc[y] - sc[x]);
    const copy = acts.slice();
    for (let i = 0; i < idx.length; i++) acts[i] = copy[idx[i]];
  }
}
