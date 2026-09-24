import { maskPoints, popcount, TARGET } from '../core/cards';
import { randomSeed, Rng, seededRng } from '../core/rng';
import { ACCEPT, GameState, K_CONTINUE, K_GIVE, mkAct, Phase } from '../core/state';
import { PlayerView } from '../core/view';
import { BeliefOptions, DEFAULT_BELIEF, effectiveSampleSize, sampleWorlds, World } from './belief';
import { claimPolicy, DEFAULT_POLICY, PlayoutPolicy, policyAction } from './heuristic';
import { Solver } from './solver';

export interface SearchOptions {
  /** Stop after this many iterations. */
  iterations?: number;
  /** Stop after this many milliseconds. */
  timeMs?: number;
  /** Number of sampled worlds (hidden-card layouts). */
  worlds?: number;
  belief?: Partial<BeliefOptions>;
  /** UCB exploration constant. */
  exploration?: number;
  /** Playout policy (both players), also used for the opponent's claims inside the tree. */
  policy?: Partial<PlayoutPolicy>;
  seed?: number;
  /** When the opponent has proposed a raise, search the position as if it were accepted. */
  acceptFirst?: boolean;
  /** Only search the root decision, then evaluate (flat determinized Monte Carlo / PIMC). For comparison. */
  flat?: boolean;
  /**
   * How a leaf is valued in its world: 'solver' solves the rest of the hand exactly with all cards known,
   * 'rollout' plays it out with the heuristic policy.
   */
  evaluator?: 'solver' | 'rollout';
}

export interface ActionStat {
  action: number;
  visits: number;
  /** Estimated probability of winning the hand after this action. */
  winRate: number;
}

export interface SearchResult {
  /** Most visited first. */
  actions: ActionStat[];
  best: number;
  winProb: number;
  iterations: number;
  worlds: number;
  /** Effective number of worlds after inference weighting. */
  ess: number;
  /** P(my pile is worth 31+) over the weighted worlds. */
  claimProb: number;
  /** Expected value of my pile, counting the face-down cards I cannot see. */
  expectedScore: number;
  /** P(opponent holds card c), by card id. */
  oppCardProb: number[];
  ms: number;
}

class Stat {
  n = 0;
  w = 0;
  avail = 0;
}

class Node {
  children = new Map<number, Node>();
  stats = new Map<number, Stat>();
  visits = 0;

  stat(a: number): Stat {
    let s = this.stats.get(a);
    if (!s) {
      s = new Stat();
      this.stats.set(a, s);
    }
    return s;
  }

  child(key: number): Node {
    let c = this.children.get(key);
    if (!c) {
      c = new Node();
      this.children.set(key, c);
    }
    return c;
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * What the searching player observes about an action: its own actions fully, the opponent's face-down gives
 * only by count, plus its own newly drawn cards. Tree nodes are keyed by this, so every node is one of the
 * searcher's information sets and its statistics average over all hidden-card layouts.
 */
function observationKey(s: GameState, a: number, actor: number, me: number): number {
  let key = actor !== me && a >>> 20 === K_GIVE ? mkAct(K_GIVE, popcount(a & 0xfffff)) : a;
  if (a >>> 20 === K_CONTINUE) {
    let drawn = 0;
    for (const d of s.drawLog) if (d >> 5 === me) drawn |= 1 << (d & 31);
    key += drawn * 16777216;
  }
  return key;
}

/**
 * Single-observer Information Set MCTS over determinized worlds sampled with opponent-model inference.
 * The objective is the probability of winning the hand; stakes are decided separately (see stake.ts).
 */
export function search(view: PlayerView, opts: SearchOptions = {}): SearchResult {
  const start = now();
  const me = view.me;
  if (view.toAct !== me) throw new Error('Not my decision');
  const rng: Rng = seededRng(opts.seed ?? randomSeed());
  const belief = { ...DEFAULT_BELIEF, ...opts.belief };
  const worlds: World[] = sampleWorlds(view, opts.worlds ?? 400, rng, belief);
  for (const w of worlds) {
    if (opts.acceptFirst && w.state.phase === Phase.Raise) w.state.apply(ACCEPT);
    w.state.noRaise = true;
  }

  const cumulative: number[] = [];
  let total = 0;
  for (const w of worlds) cumulative.push((total += w.weight));
  const pickWorld = (): number => {
    const x = rng() * total;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const useSolver = (opts.evaluator ?? 'solver') === 'solver';
  const solvers = new Map<number, Solver>();

  const maxIter = opts.iterations ?? (opts.timeMs ? Infinity : 5000);
  const deadline = opts.timeMs ? start + opts.timeMs : Infinity;
  const c = opts.exploration ?? 0.7;
  const policy: PlayoutPolicy = { ...DEFAULT_POLICY, ...opts.policy };
  const root = new Node();
  const buf: number[] = [];
  const pathNodes: Node[] = [];
  const pathStats: Stat[] = [];
  const pathMine: boolean[] = [];
  let iter = 0;

  for (; iter < maxIter; iter++) {
    if ((iter & 31) === 0 && now() > deadline) break;
    const wi = pickWorld();
    const s = worlds[wi].state.clone();
    let node = root;
    pathNodes.length = pathStats.length = pathMine.length = 0;
    let expanded = false;

    while (!s.over && !expanded && !(opts.flat && node !== root)) {
      const actor = s.toAct;
      if (actor !== me && s.phase === Phase.Claim) {
        // The opponent decides claims from its own (uncertain) knowledge of its pile.
        const a = claimPolicy(s, policy);
        s.apply(a);
        node = node.child(observationKey(s, a, actor, me));
        continue;
      }
      buf.length = 0;
      s.legal(buf);
      if (buf.length === 1 && node !== root) {
        const a = buf[0];
        s.apply(a);
        node = node.child(observationKey(s, a, actor, me));
        continue;
      }
      const mine = actor === me;
      let chosen = -1;
      let untried = 0;
      for (const a of buf) {
        const st = node.stat(a);
        if (!mine) st.avail++;
        if (st.n === 0) untried++;
      }
      if (untried > 0) {
        let k = Math.floor(rng() * untried);
        for (const a of buf) {
          if (node.stats.get(a)!.n === 0 && k-- === 0) {
            chosen = a;
            break;
          }
        }
        expanded = true;
      } else {
        let bestVal = -Infinity;
        const lnN = Math.log(Math.max(1, node.visits));
        for (const a of buf) {
          const st = node.stats.get(a)!;
          const mean = mine ? st.w / st.n : 1 - st.w / st.n;
          const val = mean + c * Math.sqrt((mine ? lnN : Math.log(st.avail)) / st.n);
          if (val > bestVal) {
            bestVal = val;
            chosen = a;
          }
        }
      }
      pathNodes.push(node);
      pathStats.push(node.stats.get(chosen)!);
      pathMine.push(mine);
      s.apply(chosen);
      node = node.child(observationKey(s, chosen, actor, me));
    }

    let r: number;
    if (s.over) {
      r = s.winner === me ? 1 : 0;
    } else if (useSolver) {
      let solver = solvers.get(wi);
      if (!solver) solvers.set(wi, (solver = new Solver(me)));
      r = solver.solve(s);
    } else {
      while (!s.over) s.apply(policyAction(s, rng, buf, policy));
      r = s.winner === me ? 1 : 0;
    }
    for (let i = 0; i < pathNodes.length; i++) {
      pathNodes[i].visits++;
      pathStats[i].n++;
      pathStats[i].w += r; // Always stored from my point of view.
    }
  }

  const actions: ActionStat[] = [];
  for (const [action, st] of root.stats) {
    actions.push({ action, visits: st.n, winRate: st.n ? st.w / st.n : 0 });
  }
  actions.sort((a, b) => b.visits - a.visits || b.winRate - a.winRate);

  let claimW = 0, scoreW = 0;
  const oppCardProb = new Array(20).fill(0);
  for (const w of worlds) {
    const pile = w.state.piles[me];
    if (maskPoints(pile) >= TARGET) claimW += w.weight;
    scoreW += w.weight * maskPoints(pile);
    for (let m = w.state.hands[1 - me]; m; m &= m - 1) oppCardProb[31 - Math.clz32(m & -m)] += w.weight;
  }
  for (let i = 0; i < 20; i++) oppCardProb[i] /= total;

  return {
    actions,
    best: actions[0]?.action ?? -1,
    winProb: actions[0]?.winRate ?? 0,
    iterations: iter,
    worlds: worlds.length,
    ess: effectiveSampleSize(worlds),
    claimProb: claimW / total,
    expectedScore: scoreW / total,
    oppCardProb,
    ms: now() - start,
  };
}
