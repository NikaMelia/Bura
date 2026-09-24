import { ALL_CARDS, Card, cardName, cardsOf, maskOf, maskPoints, popcount } from './cards';
import { beatOptions, canBeatAll, DEFAULT_RULES, giveOptions, isLegalLead, leadOptions, MatchScore, raiseBlockedByScore, Rules } from './rules';
import { ACCEPT, CLAIM, CONTINUE, DECLINE, EndReason, GameState, K_BEAT, K_GIVE, K_LEAD, mkAct, Phase, RAISE } from './state';

/** What one player observes. Everything the AI knows about a hand is a list of these. */
export type Obs =
  | { t: 'deal'; leader: number; trumpCard: Card; hand: Card[]; rules: Rules; score?: MatchScore }
  | { t: 'lead'; p: number; cards: Card[] }
  | { t: 'beat'; p: number; cards: Card[] }
  | { t: 'give'; p: number; count: number; cards?: Card[] }
  | { t: 'claim'; p: number }
  | { t: 'continue'; p: number }
  | { t: 'raise'; p: number }
  | { t: 'accept'; p: number }
  | { t: 'decline'; p: number }
  | { t: 'draw'; p: number; card?: Card }
  | { t: 'end'; winner: number; points: number; reason: EndReason };

export interface HandResult {
  winner: number;
  points: number;
  reason: EndReason;
}

/**
 * A player's information set, rebuilt by folding observations. Built the same way from the engine
 * (play against the AI) and from what the user types in (advisor for a real game).
 */
export class PlayerView {
  readonly me: number;
  rules!: Rules;
  /** Match score before this hand, by seat. */
  matchScore: MatchScore = [0, 0];
  history: Obs[] = [];
  trumpCard: Card = -1;
  trumpSuit = 0;
  firstLeader = 0;
  leader = 0;
  toAct = 0;
  phase: Phase = Phase.Lead;
  hand = 0;
  oppCount = 0;
  stockCount = 0;
  trumpInStock = true;
  /** Cards known to be in the opponent's hand (the trump card, once they draw it). */
  oppKnown = 0;
  /** Cards in my pile whose identity I know. */
  myPileKnown = 0;
  /** Number of cards given to me face down. */
  myHiddenCount = 0;
  /** The opponent's pile. I know all of it. */
  oppPile = 0;
  /** Cards I gave the opponent face down (they don't know them). */
  oppPileHidden = 0;
  faceUp = 0;
  lead = 0;
  stake = 1;
  raiseRight = -1;
  raiser = -1;
  resumePhase: Phase = Phase.Lead;
  lastWinner = -1;
  /** Players still to draw, in order, after a CONTINUE. */
  pendingDraws: number[] = [];
  result: HandResult | null = null;

  constructor(me: number) {
    this.me = me;
  }

  static from(me: number, history: Obs[]): PlayerView {
    const v = new PlayerView(me);
    for (const o of history) v.apply(o);
    return v;
  }

  get opp(): number {
    return 1 - this.me;
  }

  get over(): boolean {
    return this.phase === Phase.Over;
  }

  /** Cards whose location I don't know: opponent's hand, the stock (minus the trump card), my face-down pile. */
  unknownMask(): number {
    const trumpBit = this.trumpInStock ? 1 << this.trumpCard : 0;
    return ALL_CARDS & ~(this.hand | this.myPileKnown | this.oppPile | this.oppKnown | this.lead | trumpBit);
  }

  /** Cards the opponent might hold. */
  possibleOppCards(): number {
    return this.unknownMask() | this.oppKnown;
  }

  myKnownPoints(): number {
    return maskPoints(this.myPileKnown);
  }

  oppPoints(): number {
    return maskPoints(this.oppPile);
  }

  canRaise(p: number): boolean {
    if (this.over || this.stake >= this.rules.maxStake || this.toAct !== p) return false;
    if (this.raiseRight !== -1 && this.raiseRight !== p) return false;
    if (raiseBlockedByScore(this.rules, this.matchScore, p)) return false;
    if (this.phase === Phase.Lead) return true;
    return this.phase === Phase.Respond && this.rules.defenderMayRaise;
  }

  /** Legal actions for me (empty if it is not my decision). */
  legal(): number[] {
    if (this.toAct !== this.me) return [];
    const out: number[] = [];
    switch (this.phase) {
      case Phase.Lead:
        for (const m of leadOptions(this.hand)) out.push(mkAct(K_LEAD, m));
        break;
      case Phase.Respond:
        for (const m of beatOptions(this.hand, this.lead, this.trumpSuit)) out.push(mkAct(K_BEAT, m));
        for (const m of giveOptions(this.hand, popcount(this.lead))) out.push(mkAct(K_GIVE, m));
        break;
      case Phase.Claim:
        return [CLAIM, CONTINUE];
      case Phase.Raise:
        return [ACCEPT, DECLINE];
      default:
        return [];
    }
    if (this.canRaise(this.me)) out.push(RAISE);
    return out;
  }

  /** Applies one observation. Throws with a readable message if it is inconsistent with what is known. */
  apply(o: Obs): void {
    if (o.t !== 'deal' && this.history.length === 0) throw new Error('The hand has not been dealt yet');
    if (this.result) throw new Error('The hand is over');
    switch (o.t) {
      case 'deal':
        this.applyDeal(o);
        break;
      case 'raise':
        this.expect(o.p, [Phase.Lead, Phase.Respond]);
        if (!this.canRaise(o.p)) throw new Error('That player may not raise now');
        this.raiser = o.p;
        this.resumePhase = this.phase;
        this.phase = Phase.Raise;
        this.toAct = 1 - o.p;
        break;
      case 'accept':
        this.expect(o.p, [Phase.Raise]);
        this.stake++;
        this.raiseRight = o.p;
        this.phase = this.resumePhase;
        this.toAct = this.raiser;
        this.raiser = -1;
        break;
      case 'decline':
        this.expect(o.p, [Phase.Raise]);
        this.phase = Phase.Over;
        this.toAct = -1;
        break;
      case 'lead': {
        this.expect(o.p, [Phase.Lead]);
        const m = maskOf(o.cards);
        this.takeFromHand(o.p, m, o.cards.length);
        const shapeHand = o.p === this.me ? this.hand | m : m;
        if (!isLegalLead(shapeHand, m)) throw new Error('A lead is 1 to 3 cards of one suit');
        this.faceUp |= m;
        this.lead = m;
        this.phase = Phase.Respond;
        this.toAct = 1 - o.p;
        break;
      }
      case 'beat': {
        this.expect(o.p, [Phase.Respond]);
        const m = maskOf(o.cards);
        if (!canBeatAll(o.cards, cardsOf(this.lead), this.trumpSuit)) {
          throw new Error(`${o.cards.map(cardName).join(' ')} does not beat ${cardsOf(this.lead).map(cardName).join(' ')}`);
        }
        this.takeFromHand(o.p, m, o.cards.length);
        this.faceUp |= m;
        if (o.p === this.me) this.myPileKnown |= this.lead | m;
        else this.oppPile |= this.lead | m;
        this.endTrick(o.p);
        break;
      }
      case 'give': {
        this.expect(o.p, [Phase.Respond]);
        if (o.count !== popcount(this.lead)) throw new Error(`Must give exactly ${popcount(this.lead)} card(s)`);
        if (o.p === this.me) {
          if (!o.cards || o.cards.length !== o.count) throw new Error('Say which cards you gave');
          const m = maskOf(o.cards);
          this.takeFromHand(o.p, m, o.count);
          this.oppPile |= this.lead | m;
          this.oppPileHidden |= m;
        } else {
          if (o.count > this.oppCount) throw new Error('The opponent does not have that many cards');
          this.oppCount -= o.count;
          // A known card may be among the given ones; its location is no longer certain.
          this.oppKnown = 0;
          this.myPileKnown |= this.lead;
          this.myHiddenCount += o.count;
        }
        this.endTrick(1 - o.p);
        break;
      }
      case 'claim':
        this.expect(o.p, [Phase.Claim]);
        this.phase = Phase.Over;
        this.toAct = -1;
        break;
      case 'continue':
        this.expect(o.p, [Phase.Claim]);
        this.startDraws();
        break;
      case 'draw':
        o = this.applyDraw(o);
        break;
      case 'end':
        if (this.phase !== Phase.Over && o.reason !== 'bura') throw new Error('The hand is not finished yet');
        this.phase = Phase.Over;
        this.toAct = -1;
        this.result = { winner: o.winner, points: o.points, reason: o.reason };
        break;
    }
    this.history.push(o);
  }

  private applyDeal(o: Extract<Obs, { t: 'deal' }>): void {
    if (this.history.length) throw new Error('Already dealt');
    const hand = maskOf(o.hand);
    if (o.hand.length !== 3 || popcount(hand) !== 3) throw new Error('You need exactly 3 cards');
    if (hand & (1 << o.trumpCard)) throw new Error('The trump card cannot be in your hand');
    this.rules = { ...DEFAULT_RULES, ...o.rules };
    this.matchScore = o.score ?? [0, 0];
    this.trumpCard = o.trumpCard;
    this.trumpSuit = (o.trumpCard / 5) | 0;
    this.firstLeader = this.leader = this.toAct = o.leader;
    this.phase = Phase.Lead;
    this.hand = hand;
    this.oppCount = 3;
    this.stockCount = 14;
  }

  /** Returns the observation with the trump card filled in when it was the card drawn. */
  private applyDraw(o: Extract<Obs, { t: 'draw' }>): Obs {
    if (this.phase !== Phase.Draw || this.pendingDraws[0] !== o.p) throw new Error('No draw expected for that player now');
    const isTrump = this.stockCount === 1;
    let card = o.card;
    if (isTrump) {
      if (card !== undefined && card !== this.trumpCard) throw new Error(`The last card is the trump ${cardName(this.trumpCard)}`);
      card = this.trumpCard;
      this.trumpInStock = false;
    } else if (card !== undefined && !(this.unknownMask() & (1 << card))) {
      throw new Error(`${cardName(card)} cannot be in the stock`);
    }
    if (o.p === this.me) {
      if (card === undefined) throw new Error('Say which card you drew');
      this.hand |= 1 << card;
    } else {
      this.oppCount++;
      if (isTrump) this.oppKnown |= 1 << this.trumpCard;
    }
    this.stockCount--;
    this.pendingDraws.shift();
    if (this.pendingDraws.length === 0) {
      this.phase = Phase.Lead;
      this.toAct = this.leader;
    } else {
      this.toAct = this.pendingDraws[0];
    }
    return card === o.card ? o : { t: 'draw', p: o.p, card: isTrump || o.p === this.me ? card : undefined };
  }

  /** True when the next card to be drawn is the face-up trump card. */
  nextDrawIsTrump(): boolean {
    return this.phase === Phase.Draw && this.stockCount === 1;
  }

  private startDraws(): void {
    const counts = [0, 0];
    counts[this.me] = popcount(this.hand);
    counts[this.opp] = this.oppCount;
    let stock = this.stockCount;
    let p = this.leader;
    this.pendingDraws = [];
    while (stock > 0 && (counts[0] < 3 || counts[1] < 3)) {
      if (counts[p] < 3) {
        counts[p]++;
        stock--;
        this.pendingDraws.push(p);
      }
      p = 1 - p;
    }
    if (this.pendingDraws.length) {
      this.phase = Phase.Draw;
      this.toAct = this.pendingDraws[0];
    } else {
      this.phase = Phase.Lead;
      this.toAct = this.leader;
    }
  }

  private endTrick(w: number): void {
    this.lead = 0;
    this.leader = w;
    this.lastWinner = w;
    if (this.hand === 0 && this.oppCount === 0 && this.stockCount === 0) {
      this.phase = Phase.Over;
      this.toAct = -1;
    } else {
      this.phase = Phase.Claim;
      this.toAct = w;
    }
  }

  private expect(p: number, phases: Phase[]): void {
    if (!phases.includes(this.phase)) throw new Error('That is not possible at this point of the hand');
    if (p !== this.toAct) throw new Error(`It is ${this.toAct === this.me ? 'your' : "the opponent's"} turn`);
  }

  private takeFromHand(p: number, m: number, n: number): void {
    if (popcount(m) !== n || n === 0) throw new Error('Duplicate or missing cards');
    if (p === this.me) {
      if ((m & this.hand) !== m) throw new Error('You do not hold those cards');
      this.hand &= ~m;
    } else {
      if ((m & this.possibleOppCards()) !== m) throw new Error('The opponent cannot hold those cards');
      if (n > this.oppCount) throw new Error('The opponent does not have that many cards');
      this.oppCount -= n;
      this.oppKnown &= ~m;
    }
  }
}

/** Runs one hand with full information and records what each player observes. */
export class HandRunner {
  readonly state: GameState;
  readonly obs: [Obs[], Obs[]] = [[], []];
  readonly views: [PlayerView, PlayerView] = [new PlayerView(0), new PlayerView(1)];

  constructor(deck: Card[], leader: number, rules: Rules, score: MatchScore = [0, 0]) {
    this.state = GameState.deal(deck, leader, rules, score);
    for (const p of [0, 1]) {
      this.emit(p, { t: 'deal', leader, trumpCard: this.state.trumpCard, hand: cardsOf(this.state.hands[p]), rules, score });
    }
    this.emitEndIfOver();
  }

  view(p: number): PlayerView {
    return this.views[p];
  }

  act(a: number): void {
    const s = this.state;
    if (!s.isLegal(a)) throw new Error(`Illegal action ${a}`);
    const p = s.toAct;
    const kind = a >>> 20;
    const cards = cardsOf(a & ALL_CARDS);
    s.apply(a);
    for (const q of [0, 1]) {
      switch (kind) {
        case K_LEAD: this.emit(q, { t: 'lead', p, cards }); break;
        case K_BEAT: this.emit(q, { t: 'beat', p, cards }); break;
        case K_GIVE: this.emit(q, { t: 'give', p, count: cards.length, cards: q === p ? cards : undefined }); break;
        default: {
          const t = (['claim', 'continue', 'raise', 'accept', 'decline'] as const)[kind - 4];
          this.emit(q, { t, p });
          if (t === 'continue') {
            for (const d of s.drawLog) {
              const dp = d >> 5, card = d & 31;
              this.emit(q, { t: 'draw', p: dp, card: dp === q || card === s.trumpCard ? card : undefined });
            }
          }
        }
      }
    }
    this.emitEndIfOver();
  }

  private emitEndIfOver(): void {
    const s = this.state;
    if (s.phase !== Phase.Over) return;
    for (const q of [0, 1]) this.emit(q, { t: 'end', winner: s.winner, points: s.stake, reason: s.reason as EndReason });
  }

  private emit(p: number, o: Obs): void {
    this.obs[p].push(o);
    this.views[p].apply(o);
  }
}
