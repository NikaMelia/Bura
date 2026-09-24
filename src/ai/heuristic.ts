import { ALL_CARDS, maskPoints, popcount, rankOf, suitOf, TARGET } from '../core/cards';
import { beatersOf } from '../core/rules';
import { CLAIM, CONTINUE, GameState, K_BEAT, K_GIVE, K_LEAD, Phase } from '../core/state';

/*
 * Fast hand-written evaluation of card actions, in rough "points" units. Only reads what the acting player
 * can know, so it is safe to call on a determinized state. Used three ways:
 *   - as the easy AI,
 *   - as the playout policy inside the search,
 *   - as the opponent model when inferring hidden cards from the opponent's past choices.
 */

const BINOM: number[][] = [];
for (let n = 0; n <= 20; n++) {
  BINOM[n] = [];
  for (let k = 0; k <= 20; k++) BINOM[n][k] = k === 0 ? 1 : n === 0 ? 0 : BINOM[n - 1][k - 1] + (BINOM[n - 1][k] ?? 0);
}

/** P(a random h-card hand drawn from u cards contains at least one of b specific cards). */
function pAny(b: number, u: number, h: number): number {
  if (b <= 0 || h <= 0) return 0;
  if (u - b < h) return 1;
  return 1 - BINOM[u - b][h] / BINOM[u][h];
}

/** How much a card is worth keeping for later, beyond its points. */
function keepValue(mask: number, trump: number): number {
  let v = 0;
  for (let m = mask; m; m &= m - 1) {
    const c = 31 - Math.clz32(m & -m);
    const r = rankOf(c);
    v += suitOf(c) === trump ? 6 + 2 * r : r === 4 ? 3 : r === 3 ? 2 : 0;
  }
  return v;
}

/** The acting player's rough estimate of its own score (it cannot see cards given to it face down). */
export function estimatedOwnScore(s: GameState, p: number): number {
  const known = maskPoints(s.piles[p] & ~s.hidden[p]);
  const k = popcount(s.hidden[p]);
  if (k === 0) return known;
  const unseen = ALL_CARDS & ~s.seen[p];
  const avg = maskPoints(unseen) / Math.max(1, popcount(unseen));
  // Givers usually dump low cards, so shade the average down.
  return known + k * Math.min(avg, 4.5);
}

export function scoreActions(s: GameState, acts: number[], out: number[]): void {
  const p = s.toAct;
  const trump = s.trumpSuit;
  const unseen = ALL_CARDS & ~s.seen[p];
  const u = popcount(unseen);
  const oppHand = popcount(s.hands[1 - p]);
  const myEst = estimatedOwnScore(s, p);
  const oppScore = s.score(1 - p);
  const leadPts = maskPoints(s.lead);
  const lastCards = s.stockCount === 0;

  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    const kind = a >>> 20;
    const m = a & ALL_CARDS;
    const pts = maskPoints(m);
    let v = 0;
    if (kind === K_LEAD) {
      const cnt = popcount(m);
      let pBeat = 1;
      for (let x = m; x; x &= x - 1) {
        const c = 31 - Math.clz32(x & -x);
        pBeat *= pAny(popcount(beatersOf(c, trump) & unseen), u, oppHand);
      }
      if (cnt > 1) pBeat *= Math.pow(0.6, cnt - 1);
      const winGain = pts + cnt * 2.5;
      const loseCost = pts + cnt * 4;
      v = (1 - pBeat) * winGain - pBeat * loseCost - 0.6 * keepValue(m, trump);
      if (myEst + winGain >= TARGET) v += 12 * (1 - pBeat);
      if (oppScore + loseCost >= TARGET) v -= 12 * pBeat;
      if (lastCards) v += cnt; // Late in the hand, shedding several cards at once matters less to keep.
    } else if (kind === K_BEAT) {
      v = leadPts + pts - 0.7 * keepValue(m, trump);
      if (myEst + leadPts + pts >= TARGET) v += 15;
    } else if (kind === K_GIVE) {
      v = -(leadPts + pts) - 0.7 * keepValue(m, trump);
      if (oppScore + leadPts + pts >= TARGET) v -= 10;
    } else {
      v = -1000;
    }
    out[i] = v;
  }
}

export function bestHeuristicAction(s: GameState, acts: number[]): number {
  const scores: number[] = new Array(acts.length);
  scoreActions(s, acts, scores);
  let best = 0;
  for (let i = 1; i < acts.length; i++) if (scores[i] > scores[best]) best = i;
  return acts[best];
}

// --- Claim probability -----------------------------------------------------------------------------------

const claimCache = new Map<number, number>();

/**
 * P(known + sum of k cards drawn uniformly from `pool` >= TARGET). This is what a player can compute about its
 * own score: it knows how many cards it was given face down and which cards it has never seen.
 */
export function probReach(known: number, k: number, pool: number): number {
  const need = TARGET - known;
  if (need <= 0) return 1;
  if (k === 0 || need > 11 * k) return 0;
  const key = pool * 512 + k * 32 + need;
  const hit = claimCache.get(key);
  if (hit !== undefined) return hit;
  const cards: number[] = [];
  for (let m = pool; m; m &= m - 1) cards.push(maskPoints(m & -m));
  const nPool = cards.length;
  if (nPool < k) return 0;
  // ways[j][s]: number of j-card subsets with capped sum s.
  const W = need + 1;
  const ways = new Float64Array((k + 1) * W);
  ways[0] = 1;
  for (const v of cards) {
    for (let j = Math.min(k, nPool) - 1; j >= 0; j--) {
      for (let t = need; t >= 0; t--) {
        const w = ways[j * W + t];
        if (w) {
          const t2 = Math.min(need, t + v);
          ways[(j + 1) * W + t2] += w;
        }
      }
    }
  }
  const prob = ways[k * W + need] / BINOM[nPool][k];
  if (claimCache.size > 200_000) claimCache.clear();
  claimCache.set(key, prob);
  return prob;
}

export function ownClaimProbability(s: GameState, p: number): number {
  return probReach(maskPoints(s.piles[p] & ~s.hidden[p]), popcount(s.hidden[p]), ALL_CARDS & ~s.seen[p]);
}

export const CLAIM_THRESHOLD = 0.6;

export interface PlayoutPolicy {
  /** Random-move rate. */
  epsilon: number;
  /** Claim when the estimated P(31+) reaches this. */
  claimThreshold: number;
  /**
   * How a player estimates the face-down cards it was given: 'uniform' over unseen cards, 'low' assumes the
   * giver dumped its cheapest cards (only J/Q/K count unless nothing else is left), 'oracle' knows them.
   */
  claimModel: 'uniform' | 'low' | 'oracle';
}

export const DEFAULT_POLICY: PlayoutPolicy = { epsilon: 0.1, claimThreshold: CLAIM_THRESHOLD, claimModel: 'uniform' };

const LOW_CARDS = 0b00111_00111_00111_00111;

/** Claim/continue using only the claimer's own information. */
export function claimPolicy(s: GameState, policy: PlayoutPolicy = DEFAULT_POLICY): number {
  const p = s.toAct;
  if (policy.claimModel === 'oracle') return s.score(p) >= TARGET ? CLAIM : CONTINUE;
  const known = maskPoints(s.piles[p] & ~s.hidden[p]);
  const k = popcount(s.hidden[p]);
  let pool = ALL_CARDS & ~s.seen[p];
  if (policy.claimModel === 'low' && popcount(pool & LOW_CARDS) >= k) pool &= LOW_CARDS;
  return probReach(known, k, pool) >= policy.claimThreshold ? CLAIM : CONTINUE;
}

/** One move of the playout policy: greedy on the heuristic with some exploration. */
export function policyAction(s: GameState, rng: () => number, buf: number[], policy: PlayoutPolicy = DEFAULT_POLICY): number {
  if (s.phase === Phase.Claim) return claimPolicy(s, policy);
  buf.length = 0;
  s.legal(buf);
  if (buf.length === 1) return buf[0];
  if (rng() < policy.epsilon) return buf[(rng() * buf.length) | 0];
  return bestHeuristicAction(s, buf);
}

/** Softmax over heuristic scores, mixed with uniform. The opponent model used for inference. */
export function actionProbability(s: GameState, action: number, temperature: number, uniformMix: number): number {
  const acts = s.legal().filter((a) => a >>> 20 === K_LEAD || a >>> 20 === K_BEAT || a >>> 20 === K_GIVE);
  const idx = acts.indexOf(action);
  if (idx < 0) return 1e-6;
  const scores: number[] = new Array(acts.length);
  scoreActions(s, acts, scores);
  let max = -Infinity;
  for (const x of scores) max = Math.max(max, x);
  let sum = 0;
  for (let i = 0; i < scores.length; i++) sum += Math.exp((scores[i] - max) / temperature);
  const soft = Math.exp((scores[idx] - max) / temperature) / sum;
  return (1 - uniformMix) * soft + uniformMix / acts.length;
}
