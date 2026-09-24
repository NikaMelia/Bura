/*
 * Raise decisions. Card play maximizes the probability of winning the hand; the stake only changes how much
 * that hand is worth, so raises are decided from the searched win probability p.
 *
 * Accepting a raise from stake s: declining loses s; accepting risks (s+1) and wins (s+1).
 * Accept when (s+1)(2q-1) > -s, i.e. q > 1/(2(s+1)). The raiser chose to raise, which says its hand is strong,
 * and the search does not see that signal, so a margin is added.
 *
 * Proposing a raise: if declined we win s now; if accepted the hand is worth one more. Both beat not raising
 * whenever p > 0.5, but raising hands the right to raise to the opponent, so we raise only when clearly ahead.
 */

export interface StakePolicy {
  raiseThreshold: number;
  acceptMargin: number;
}

export const DEFAULT_STAKE_POLICY: StakePolicy = { raiseThreshold: 0.7, acceptMargin: 0.08 };

export function acceptThreshold(stake: number, policy: StakePolicy = DEFAULT_STAKE_POLICY): number {
  return 1 / (2 * (stake + 1)) + policy.acceptMargin;
}

export function shouldAccept(winProb: number, stake: number, policy: StakePolicy = DEFAULT_STAKE_POLICY): boolean {
  return winProb >= acceptThreshold(stake, policy);
}

export function shouldRaise(winProb: number, policy: StakePolicy = DEFAULT_STAKE_POLICY): boolean {
  return winProb >= policy.raiseThreshold;
}
