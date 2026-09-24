import { ALL_CARDS } from '../core/cards';
import { randomSeed, Rng, seededRng } from '../core/rng';
import { ACCEPT, CLAIM, CONTINUE, DECLINE, Phase, RAISE } from '../core/state';
import { PlayerView } from '../core/view';
import { AdvisorOptions, analyze, stakeContext } from './advisor';
import { sampleWorlds } from './belief';
import { bestHeuristicAction, CLAIM_THRESHOLD, policyAction, probReach } from './heuristic';
import { shouldAccept, shouldRaise } from './stake';

export interface Bot {
  readonly name: string;
  choose(view: PlayerView): number;
}

/** The full AI: ISMCTS with inference. Same code path as the advisor. */
export class SearchBot implements Bot {
  constructor(readonly name: string, readonly opts: AdvisorOptions) {}

  choose(view: PlayerView): number {
    return analyze(view, this.opts).action;
  }
}

/** Rule-of-thumb player; also the playout policy of the search. */
export class HeuristicBot implements Bot {
  readonly name = 'heuristic';
  private rng: Rng;

  constructor(seed = randomSeed(), readonly raises = true) {
    this.rng = seededRng(seed);
  }

  choose(view: PlayerView): number {
    const noInference = { inference: false, temperature: 1, uniformMix: 1 };
    if (view.phase === Phase.Claim) {
      const p = probReach(view.myKnownPoints(), view.myHiddenCount, ALL_CARDS & ~seenMask(view));
      return p >= CLAIM_THRESHOLD ? CLAIM : CONTINUE;
    }
    if (view.phase === Phase.Raise) return shouldAccept(this.quickWinProb(view, true), stakeContext(view)) ? ACCEPT : DECLINE;
    if (this.raises && view.canRaise(view.me) && shouldRaise(this.quickWinProb(view, false), stakeContext(view))) return RAISE;
    const s = sampleWorlds(view, 1, this.rng, noInference)[0].state;
    s.noRaise = true;
    return bestHeuristicAction(s, s.legal());
  }

  /** Win probability from plain playouts of the heuristic over random layouts. */
  private quickWinProb(view: PlayerView, acceptFirst: boolean): number {
    const worlds = sampleWorlds(view, 60, this.rng, { inference: false, temperature: 1, uniformMix: 1 });
    const buf: number[] = [];
    let wins = 0, n = 0;
    for (const w of worlds) {
      for (let k = 0; k < 4; k++) {
        const s = w.state.clone();
        if (acceptFirst && s.phase === Phase.Raise) s.apply(ACCEPT);
        s.noRaise = true;
        while (!s.over) s.apply(policyAction(s, this.rng, buf));
        if (s.winner === view.me) wins++;
        n++;
      }
    }
    return wins / n;
  }
}

export class RandomBot implements Bot {
  readonly name = 'random';
  private rng: Rng;

  constructor(seed = randomSeed()) {
    this.rng = seededRng(seed);
  }

  choose(view: PlayerView): number {
    const acts = view.legal().filter((a) => a !== RAISE);
    return acts[Math.floor(this.rng() * acts.length)];
  }
}

/** Cards `view.me` has seen: everything except the cards whose location it does not know. */
export function seenMask(view: PlayerView): number {
  return ALL_CARDS & ~view.unknownMask();
}

export function makeBot(
  kind: string,
  opts: { iterations?: number; timeMs?: number; seed?: number; extra?: AdvisorOptions } = {},
): Bot {
  const extra = opts.extra ?? {};
  switch (kind) {
    case 'random':
      return new RandomBot(opts.seed);
    case 'heuristic':
      return new HeuristicBot(opts.seed);
    case 'ismcts':
      return new SearchBot('ismcts', { iterations: opts.iterations ?? 3000, timeMs: opts.timeMs, seed: opts.seed, ...extra });
    case 'ismcts-noinf':
      return new SearchBot('ismcts-noinf', {
        iterations: opts.iterations ?? 3000, timeMs: opts.timeMs, seed: opts.seed, belief: { inference: false },
      });
    case 'ismcts-rollout':
      return new SearchBot('ismcts-rollout', { iterations: opts.iterations ?? 3000, seed: opts.seed, evaluator: 'rollout', ...extra });
    case 'pimc':
      return new SearchBot('pimc', { iterations: opts.iterations ?? 3000, seed: opts.seed, flat: true, ...extra });
    case 'flat':
      // Determinized Monte Carlo without a tree below the root (PIMC-style): the classic baseline.
      return new SearchBot('flat', { iterations: opts.iterations ?? 3000, timeMs: opts.timeMs, seed: opts.seed, flat: true, evaluator: 'rollout' });
  }
  throw new Error(`Unknown bot "${kind}"`);
}
