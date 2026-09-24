import { ACCEPT, CLAIM, CONTINUE, DECLINE, Phase, RAISE } from '../core/state';
import { PlayerView } from '../core/view';
import { search, SearchOptions, SearchResult } from './ismcts';
import { acceptThreshold, DEFAULT_STAKE_POLICY, shouldAccept, shouldRaise, StakePolicy } from './stake';

export type Decision = 'lead' | 'respond' | 'claim' | 'raise-response';

export interface Analysis {
  decision: Decision;
  /** The recommended action (may be RAISE, ACCEPT, DECLINE, CLAIM, CONTINUE or a card action). */
  action: number;
  /** Best card action (for lead/respond) even when a raise is recommended first. */
  cardAction: number;
  /** Estimated probability of winning the hand with best play. */
  winProb: number;
  canRaise: boolean;
  raiseRecommended: boolean;
  /** For raise-response: the win probability needed to accept. */
  acceptThreshold?: number;
  search: SearchResult;
}

export interface AdvisorOptions extends SearchOptions {
  stakePolicy?: StakePolicy;
  /** Allow the AI to propose raises at all. */
  raises?: boolean;
}

/** Recommends my next move from my information set only. */
export function analyze(view: PlayerView, opts: AdvisorOptions = {}): Analysis {
  if (view.toAct !== view.me || view.over) throw new Error('It is not your decision');
  const policy = opts.stakePolicy ?? DEFAULT_STAKE_POLICY;

  if (view.phase === Phase.Raise) {
    const res = search(view, { ...opts, acceptFirst: true });
    const accept = shouldAccept(res.winProb, view.stake, policy);
    return {
      decision: 'raise-response',
      action: accept ? ACCEPT : DECLINE,
      cardAction: -1,
      winProb: res.winProb,
      canRaise: false,
      raiseRecommended: false,
      acceptThreshold: acceptThreshold(view.stake, policy),
      search: res,
    };
  }

  const res = search(view, opts);
  if (view.phase === Phase.Claim) {
    return {
      decision: 'claim',
      action: res.best === CLAIM ? CLAIM : CONTINUE,
      cardAction: -1,
      winProb: res.winProb,
      canRaise: false,
      raiseRecommended: false,
      search: res,
    };
  }

  const canRaise = view.canRaise(view.me) && opts.raises !== false;
  const raise = canRaise && shouldRaise(res.winProb, policy);
  return {
    decision: view.phase === Phase.Lead ? 'lead' : 'respond',
    action: raise ? RAISE : res.best,
    cardAction: res.best,
    winProb: res.winProb,
    canRaise,
    raiseRecommended: raise,
    search: res,
  };
}
