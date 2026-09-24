import { ALL_CARDS, Card, cardName, cardsOf, maskName, maskPoints, popcount, suitMask, suitOf, TARGET } from './cards';
import { beatOptions, giveOptions, leadOptions, MatchScore, raiseBlockedByScore, Rules } from './rules';

export const Phase = { Lead: 0, Respond: 1, Claim: 2, Raise: 3, Over: 4, Draw: 5 } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

// An action is (kind << 20) | cardMask.
export const K_LEAD = 1, K_BEAT = 2, K_GIVE = 3, K_CLAIM = 4, K_CONTINUE = 5, K_RAISE = 6, K_ACCEPT = 7, K_DECLINE = 8;
export const mkAct = (kind: number, mask = 0): number => (kind << 20) | mask;
export const actKind = (a: number): number => a >>> 20;
export const actMask = (a: number): number => a & ALL_CARDS;
export const CLAIM = mkAct(K_CLAIM), CONTINUE = mkAct(K_CONTINUE);
export const RAISE = mkAct(K_RAISE), ACCEPT = mkAct(K_ACCEPT), DECLINE = mkAct(K_DECLINE);

export type EndReason = 'claim' | 'wrong-claim' | 'declined' | 'exhausted' | 'bura';

export function describeAction(a: number): string {
  const m = actMask(a);
  switch (actKind(a)) {
    case K_LEAD: return `lead ${maskName(m)}`;
    case K_BEAT: return `beat with ${maskName(m)}`;
    case K_GIVE: return `give ${maskName(m)} face down`;
    case K_CLAIM: return 'claim ვარ (31+)';
    case K_CONTINUE: return 'continue';
    case K_RAISE: return 'raise the stake';
    case K_ACCEPT: return 'accept the raise';
    case K_DECLINE: return 'decline the raise';
  }
  return `?${a}`;
}

/**
 * Full (omniscient) state of one hand. Used by the engine and, after determinization, by the AI's simulations.
 * Players are 0 and 1.
 */
export class GameState {
  rules!: Rules;
  /** Match score before this hand. */
  matchScore: MatchScore = [0, 0];
  trumpSuit = 0;
  trumpCard: Card = 0;
  hands = [0, 0];
  /** All cards each player has won. */
  piles = [0, 0];
  /** Cards in piles[p] that p has never seen (given to p face down). */
  hidden = [0, 0];
  /** Every card p has seen: own hand history, face-up plays, the trump card. */
  seen = [0, 0];
  faceUp = 0;
  /** Draw order; the last entry is the face-up trump card. Never mutated, so clones share it. */
  stock: Card[] = [];
  stockPos = 0;
  leader = 0;
  toAct = 0;
  phase: Phase = Phase.Lead;
  lead = 0;
  stake = 1;
  /** -1: either player may raise. Otherwise only this player may. */
  raiseRight = -1;
  raiser = -1;
  resumePhase: Phase = Phase.Lead;
  lastWinner = -1;
  winner = -1;
  reason: EndReason | '' = '';
  /** Disables raising (used inside search, where stakes are handled separately). */
  noRaise = false;
  /** Draws made by the last CONTINUE, encoded player * 32 + card. */
  drawLog: number[] = [];

  /** deck[0..5] are dealt alternately starting with the leader; deck[6] is the trump card; deck[7..19] is the stock. */
  static deal(deck: Card[], leader: number, rules: Rules, score: MatchScore = [0, 0]): GameState {
    if (deck.length !== 20 || new Set(deck).size !== 20) throw new Error('A deck must hold the 20 distinct cards');
    const s = new GameState();
    s.rules = rules;
    s.matchScore = score;
    s.leader = s.toAct = leader;
    for (let i = 0; i < 6; i++) s.hands[i % 2 === 0 ? leader : 1 - leader] |= 1 << deck[i];
    s.trumpCard = deck[6];
    s.trumpSuit = suitOf(deck[6]);
    s.stock = [...deck.slice(7), deck[6]];
    for (let p = 0; p < 2; p++) s.seen[p] = s.hands[p] | (1 << s.trumpCard);
    s.checkBura();
    return s;
  }

  clone(): GameState {
    const s: GameState = Object.create(GameState.prototype);
    s.rules = this.rules;
    s.matchScore = this.matchScore;
    s.trumpSuit = this.trumpSuit;
    s.trumpCard = this.trumpCard;
    s.hands = [this.hands[0], this.hands[1]];
    s.piles = [this.piles[0], this.piles[1]];
    s.hidden = [this.hidden[0], this.hidden[1]];
    s.seen = [this.seen[0], this.seen[1]];
    s.faceUp = this.faceUp;
    s.stock = this.stock;
    s.stockPos = this.stockPos;
    s.leader = this.leader;
    s.toAct = this.toAct;
    s.phase = this.phase;
    s.lead = this.lead;
    s.stake = this.stake;
    s.raiseRight = this.raiseRight;
    s.raiser = this.raiser;
    s.resumePhase = this.resumePhase;
    s.lastWinner = this.lastWinner;
    s.winner = this.winner;
    s.reason = this.reason;
    s.noRaise = this.noRaise;
    s.drawLog = [];
    return s;
  }

  get stockCount(): number {
    return this.stock.length - this.stockPos;
  }

  get over(): boolean {
    return this.phase === Phase.Over;
  }

  score(p: number): number {
    return maskPoints(this.piles[p]);
  }

  canRaise(p: number): boolean {
    if (this.noRaise || this.stake >= this.rules.maxStake) return false;
    if (this.raiseRight !== -1 && this.raiseRight !== p) return false;
    if (this.toAct !== p || raiseBlockedByScore(this.rules, this.matchScore, p)) return false;
    if (this.phase === Phase.Lead) return true;
    return this.phase === Phase.Respond && this.rules.defenderMayRaise;
  }

  legal(out: number[] = []): number[] {
    const p = this.toAct;
    switch (this.phase) {
      case Phase.Lead: {
        const start = out.length;
        leadOptions(this.hands[p], out);
        for (let i = start; i < out.length; i++) out[i] = (K_LEAD << 20) | out[i];
        break;
      }
      case Phase.Respond: {
        const start = out.length;
        beatOptions(this.hands[p], this.lead, this.trumpSuit, out);
        for (let i = start; i < out.length; i++) out[i] = (K_BEAT << 20) | out[i];
        const mid = out.length;
        giveOptions(this.hands[p], popcount(this.lead), out);
        for (let i = mid; i < out.length; i++) out[i] = (K_GIVE << 20) | out[i];
        break;
      }
      case Phase.Claim:
        out.push(CLAIM, CONTINUE);
        return out;
      case Phase.Raise:
        out.push(ACCEPT, DECLINE);
        return out;
      default:
        return out;
    }
    if (this.canRaise(p)) out.push(RAISE);
    return out;
  }

  isLegal(a: number): boolean {
    return this.legal().includes(a);
  }

  apply(a: number): void {
    const kind = a >>> 20;
    const m = a & ALL_CARDS;
    const p = this.toAct;
    const o = 1 - p;
    switch (kind) {
      case K_LEAD:
        this.hands[p] &= ~m;
        this.lead = m;
        this.faceUp |= m;
        this.seen[0] |= m;
        this.seen[1] |= m;
        this.phase = Phase.Respond;
        this.toAct = o;
        return;
      case K_BEAT:
        this.hands[p] &= ~m;
        this.faceUp |= m;
        this.seen[0] |= m;
        this.seen[1] |= m;
        this.piles[p] |= this.lead | m;
        this.endTrick(p);
        return;
      case K_GIVE:
        this.hands[p] &= ~m;
        this.piles[o] |= this.lead | m;
        this.hidden[o] |= m;
        this.endTrick(o);
        return;
      case K_CLAIM: {
        const ok = this.score(p) >= TARGET;
        this.finish(ok ? p : o, ok ? 'claim' : 'wrong-claim');
        return;
      }
      case K_CONTINUE:
        this.drawCards();
        this.phase = Phase.Lead;
        this.toAct = this.leader;
        this.checkBura();
        return;
      case K_RAISE:
        this.raiser = p;
        this.resumePhase = this.phase;
        this.phase = Phase.Raise;
        this.toAct = o;
        return;
      case K_ACCEPT:
        this.stake++;
        this.raiseRight = p;
        this.phase = this.resumePhase;
        this.toAct = this.raiser;
        this.raiser = -1;
        return;
      case K_DECLINE:
        this.finish(this.raiser, 'declined');
        return;
    }
    throw new Error(`Unknown action ${a}`);
  }

  private endTrick(w: number): void {
    this.lead = 0;
    this.leader = w;
    this.lastWinner = w;
    if (this.hands[0] === 0 && this.hands[1] === 0 && this.stockPos === this.stock.length) {
      // Nothing left to play: the last trick winner's claim is forced.
      this.finish(this.score(w) >= TARGET ? w : 1 - w, 'exhausted');
    } else {
      this.phase = Phase.Claim;
      this.toAct = w;
    }
  }

  private drawCards(): void {
    this.drawLog.length = 0;
    let p = this.leader;
    while (this.stockPos < this.stock.length) {
      const needP = popcount(this.hands[p]) < 3;
      if (!needP && popcount(this.hands[1 - p]) >= 3) break;
      if (needP) {
        const c = this.stock[this.stockPos++];
        this.hands[p] |= 1 << c;
        this.seen[p] |= 1 << c;
        this.drawLog.push(p * 32 + c);
      }
      p = 1 - p;
    }
  }

  private checkBura(): void {
    if (!this.rules.buraWins || this.phase === Phase.Over) return;
    const trumps = suitMask(this.trumpSuit);
    for (const p of [this.leader, 1 - this.leader]) {
      if (popcount(this.hands[p] & trumps) === 3) {
        this.finish(p, 'bura');
        return;
      }
    }
  }

  private finish(winner: number, reason: EndReason): void {
    this.winner = winner;
    this.reason = reason;
    this.phase = Phase.Over;
    this.toAct = -1;
  }

  toString(): string {
    const h = (m: number) => cardsOf(m).map(cardName).join(' ');
    return `trump ${cardName(this.trumpCard)} | P0 [${h(this.hands[0])}] ${this.score(0)}pts | P1 [${h(this.hands[1])}] ${this.score(1)}pts | stock ${this.stockCount} | phase ${this.phase} toAct ${this.toAct}`;
  }
}

export function shuffledDeck(rng: () => number): Card[] {
  const deck = Array.from({ length: 20 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
