/*
 * Raise decisions. Card play maximizes the probability of winning the hand; the stake only changes what the
 * hand is worth, so raises are decided from the searched win probability p and the value of each outcome.
 *
 * The value of winning or losing d points is V(d):
 *   - scoring without a match limit, V(d) = d (points);
 *   - in a match to N, V(d) is the chance of winning the match from the resulting score, taken from a table that
 *     assumes later hands are even (see matchEquity). A point is worth more or less depending on the score:
 *     at 2-2 in a match to 3 the stake does not matter at all.
 *
 * Accepting a raise from stake s: declining gives V(-s); accepting gives q V(s+1) + (1-q) V(-s-1). The raiser
 * chose to raise, which signals a strong hand the search cannot see, so q is reduced by a safety margin.
 * With V(d) = d this is the familiar rule q > 1/(2(s+1)) + margin.
 *
 * Proposing a raise: scoring without a limit, raise when p >= raiseThreshold (tuned by self-play). In a match,
 * raise when the worse of the opponent's two replies (accept or decline) still beats not raising by a margin,
 * since raising hands the next raise to the opponent.
 */

export interface StakePolicy {
  raiseThreshold: number;
  acceptMargin: number;
  /** Match mode: minimum gain in match-winning chance for a raise. */
  matchRaiseGain: number;
}

export const DEFAULT_STAKE_POLICY: StakePolicy = { raiseThreshold: 0.7, acceptMargin: 0.08, matchRaiseGain: 0.02 };

export interface StakeContext {
  stake: number;
  /** Match length; 0 when hands are scored without a limit. */
  matchTo: number;
  /** Match score before this hand. */
  myScore: number;
  oppScore: number;
}

export const pointsContext = (stake: number): StakeContext => ({ stake, matchTo: 0, myScore: 0, oppScore: 0 });

/** P(winning a match to `target` from score (a, b)) if every later hand is a 50/50 single point. */
export function matchEquity(a: number, b: number, target: number): number {
  const memo = new Map<number, number>();
  const e = (x: number, y: number): number => {
    if (x >= target) return 1;
    if (y >= target) return 0;
    const key = x * 64 + y;
    let v = memo.get(key);
    if (v === undefined) {
      v = 0.5 * e(x + 1, y) + 0.5 * e(x, y + 1);
      memo.set(key, v);
    }
    return v;
  };
  return e(a, b);
}

/** Value of winning d points this hand (negative d: losing). */
export function outcomeValue(ctx: StakeContext, d: number): number {
  if (ctx.matchTo <= 0) return d;
  return d >= 0 ? matchEquity(ctx.myScore + d, ctx.oppScore, ctx.matchTo) : matchEquity(ctx.myScore, ctx.oppScore - d, ctx.matchTo);
}

/** Expected value of playing the hand out at the current stake with win probability p. */
export function handValue(p: number, ctx: StakeContext): number {
  return p * outcomeValue(ctx, ctx.stake) + (1 - p) * outcomeValue(ctx, -ctx.stake);
}

/** Win probability needed to accept a raise from ctx.stake. */
export function acceptThreshold(ctx: StakeContext, policy: StakePolicy = DEFAULT_STAKE_POLICY): number {
  const s = ctx.stake;
  const decline = outcomeValue(ctx, -s);
  const win = outcomeValue(ctx, s + 1);
  const lose = outcomeValue(ctx, -s - 1);
  if (win <= lose) return 1;
  return Math.max(0, (decline - lose) / (win - lose)) + policy.acceptMargin;
}

export function shouldAccept(winProb: number, ctx: StakeContext, policy: StakePolicy = DEFAULT_STAKE_POLICY): boolean {
  return winProb >= acceptThreshold(ctx, policy);
}

export function shouldRaise(winProb: number, ctx: StakeContext, policy: StakePolicy = DEFAULT_STAKE_POLICY): boolean {
  if (ctx.matchTo <= 0) return winProb >= policy.raiseThreshold;
  const s = ctx.stake;
  const keep = handValue(winProb, ctx);
  const declined = outcomeValue(ctx, s);
  const accepted = winProb * outcomeValue(ctx, s + 1) + (1 - winProb) * outcomeValue(ctx, -s - 1);
  return Math.min(declined, accepted) - keep >= policy.matchRaiseGain;
}
