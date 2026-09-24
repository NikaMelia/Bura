import type { Analysis } from '../ai/advisor';
import { ALL_CARDS, cardName, cardsOf, maskName, popcount } from '../core/cards';
import { canBeatAll, DEFAULT_RULES, isLegalLead, Rules } from '../core/rules';
import { actKind, K_BEAT, K_GIVE, K_LEAD, Phase } from '../core/state';
import { Obs, PlayerView } from '../core/view';
import { AiClient } from './aiClient';
import { analysisHtml, cardHtml, cardsHtml, esc, pickerHtml } from './common';
import { readRule, rulesFormHtml } from './play';

const ME = 0, OPP = 1;
type Think = 'fast' | 'normal' | 'deep';
const THINK_MS: Record<Think, number> = { fast: 500, normal: 1500, deep: 4000 };
const DECISION_PHASES: readonly number[] = [Phase.Lead, Phase.Respond, Phase.Claim, Phase.Raise];

/**
 * Advisor for a real game: you enter what happens at the table, it recommends your move.
 * Everything is kept as a list of observations, so undo is just dropping the last entry.
 */
export class AdvisorController {
  private rules: Rules = { ...DEFAULT_RULES };
  private think: Think = 'normal';
  private setupTrump = -1;
  private setupHand = 0;
  private setupLeader = ME;
  private history: Obs[] | null = null;
  /** Which entries were added automatically (opponent draws etc.), so undo skips over them. */
  private auto: boolean[] = [];
  private view: PlayerView | null = null;
  private sel = 0;
  private analysis: Analysis | null = null;
  private loading = false;
  private error = '';
  private message = '';
  private reqId = 0;
  /** Points from finished deals; the current deal's result is added when the next deal starts. */
  private tally = [0, 0];

  constructor(private ai: AiClient, private update: () => void) {}

  render(): string {
    return `<section class="advisor">${this.history ? this.gameHtml() : this.setupHtml()}</section>`;
  }

  // --- Setup --------------------------------------------------------------------------------------------

  private setupHtml(): string {
    const trumpSuit = this.setupTrump >= 0 ? (this.setupTrump / 5) | 0 : undefined;
    let h = '<p class="intro">Use this at a real table. Enter the deal, then tell the advisor what happens; it recommends your move ';
    h += 'from your cards alone and infers what the opponent probably holds from how they have played.</p>';
    h += '<h3>1. The face-up trump card</h3>';
    h += pickerHtml(ALL_CARDS & ~this.setupHand, this.setupTrump >= 0 ? 1 << this.setupTrump : 0, 'setup-trump', trumpSuit);
    h += '<h3>2. Your 3 cards</h3>';
    const allowed = this.setupTrump >= 0 ? ALL_CARDS & ~(1 << this.setupTrump) : 0;
    h += pickerHtml(allowed, this.setupHand, 'setup-hand', trumpSuit);
    h += '<h3>3. Who leads?</h3><div class="choice">';
    h += `<label><input type="radio" name="leader" data-change="setup-leader" value="0"${this.setupLeader === ME ? ' checked' : ''}> I lead</label>`;
    h += `<label><input type="radio" name="leader" data-change="setup-leader" value="1"${this.setupLeader === OPP ? ' checked' : ''}> Opponent leads</label></div>`;
    h += `<details><summary>Rules and thinking time</summary>${rulesFormHtml(this.rules)}${this.thinkHtml()}</details>`;
    const ready = this.setupTrump >= 0 && popcount(this.setupHand) === 3;
    h += `<div class="actions"><button type="button" class="primary" data-act="start"${ready ? '' : ' disabled'}>Start hand</button></div>`;
    if (this.message) h += `<div class="message">${esc(this.message)}</div>`;
    return h;
  }

  private thinkHtml(): string {
    const opt = (v: Think, label: string) => `<option value="${v}"${v === this.think ? ' selected' : ''}>${label}</option>`;
    return `<label>Thinking time <select data-change="think">${opt('fast', 'Fast (0.5s)')}${opt('normal', 'Normal (1.5s)')}${opt('deep', 'Deep (4s)')}</select></label>`;
  }

  // --- Game ---------------------------------------------------------------------------------------------

  private gameHtml(): string {
    const v = this.view!;
    const trump = v.trumpSuit;
    const t = this.tally.slice();
    if (v.result) t[v.result.winner] += v.result.points;
    let h = `<div class="scoreboard"><span>Tally: <b>You ${t[0]}</b> – <b>Opponent ${t[1]}</b></span>`;
    h += `<span>Stake <b>${v.stake}</b>${v.raiseRight === -1 ? '' : ` · next raise: ${v.raiseRight === ME ? 'you' : 'opponent'}`}</span></div>`;

    h += '<div class="status-grid">';
    h += `<div><span class="seat-label">Trump</span>${cardHtml(v.trumpCard, { trump, small: true })}<span class="muted block">${v.trumpInStock ? 'under the stock' : 'drawn'}</span></div>`;
    h += `<div><span class="seat-label">Stock</span><b>${v.stockCount}</b> cards</div>`;
    h += `<div><span class="seat-label">Opponent</span>${v.oppCount} cards · pile <b>${v.oppPoints()}</b> points`;
    if (v.oppKnown) h += ` · holds ${maskName(v.oppKnown)}`;
    h += '</div>';
    h += `<div><span class="seat-label">Your pile</span><b>${v.myKnownPoints()}</b> points you can see`;
    if (v.myHiddenCount) h += ` + ${v.myHiddenCount} face down`;
    h += '</div></div>';

    h += `<div class="seat me"><div class="seat-label">Your hand</div><div class="hand">${this.handHtml()}</div></div>`;
    if (v.lead) h += `<div class="trick-line"><span class="seat-label">${v.leader === ME ? 'You' : 'Opponent'} led</span>${cardsHtml(v.lead, { trump })}</div>`;

    h += `<div class="prompt-box">${this.promptHtml()}</div>`;
    if (this.message) h += `<div class="message">${esc(this.message)}</div>`;
    if (v.toAct === ME && DECISION_PHASES.includes(v.phase)) {
      h += analysisHtml(this.analysis, this.loading, this.error);
    }
    h += '<div class="actions footer">';
    h += `<button type="button" data-act="undo"${this.history!.length > 1 ? '' : ' disabled'}>Undo</button>`;
    h += '<button type="button" data-act="reset">New deal</button>';
    h += `<details><summary>Thinking time</summary>${this.thinkHtml()}</details></div>`;
    h += `<details class="log"><summary>Hand log</summary><ol>${this.history!.map((o) => `<li>${esc(describe(o))}</li>`).join('')}</ol></details>`;
    return h;
  }

  private handHtml(): string {
    const v = this.view!;
    const selectable = v.toAct === ME && (v.phase === Phase.Lead || v.phase === Phase.Respond);
    return cardsOf(v.hand)
      .map((c) => cardHtml(c, { trump: v.trumpSuit, act: selectable ? 'sel' : undefined, selected: selectable && (this.sel & (1 << c)) !== 0 }))
      .join('');
  }

  private promptHtml(): string {
    const v = this.view!;
    const btn = (act: string, label: string, enabled = true, cls = '') =>
      `<button type="button" class="${cls}" data-act="${act}"${enabled ? '' : ' disabled'}>${esc(label)}</button>`;
    const n = popcount(v.lead);

    if (v.result) {
      const r = v.result;
      return `<div class="result ${r.winner === ME ? 'win' : 'loss'}"><h3>${r.winner === ME ? 'You win' : 'Opponent wins'} ${r.points} point${r.points > 1 ? 's' : ''}</h3>${btn('reset', 'Next deal', true, 'primary')}</div>`;
    }
    if (v.phase === Phase.Over) {
      const last = this.history![this.history!.length - 1];
      if (last.t === 'claim') {
        const mine = last.p === ME;
        return `<p>${mine ? 'You' : 'The opponent'} said ვარ. Count the pile: was it 31 or more?</p>` +
          btn(mine ? 'end-me' : 'end-opp', 'Yes, 31+', true, 'primary') + btn(mine ? 'end-opp' : 'end-me', 'No');
      }
      return `<p>All cards are played. The last trick's winner must count their pile. Who won the hand?</p>${btn('end-me', 'I won', true, 'primary')}${btn('end-opp', 'Opponent won')}`;
    }
    if (v.phase === Phase.Draw) {
      return `<p>Which card did you draw?</p>${pickerHtml(v.unknownMask(), 0, 'draw', v.trumpSuit)}`;
    }
    const oppRaise = v.canRaise(OPP) ? btn('opp-raise', 'Opponent raised', true, 'secondary') : '';
    const myRaise = v.canRaise(ME) ? btn('my-raise', `I raised (to ${v.stake + 1})`, true, 'secondary') : '';

    switch (v.phase) {
      case Phase.Lead:
        if (v.toAct === ME) {
          const ok = isLegalLead(v.hand, this.sel);
          return `<p>Your lead. Select the card(s) you play.</p>${btn('my-lead', 'I led these', ok, 'primary')}${myRaise}`;
        }
        return `<p>The opponent leads. Tap the card(s) they led.</p>${pickerHtml(v.possibleOppCards(), this.sel, 'pick', v.trumpSuit)}` +
          btn('opp-lead', 'Opponent led these', isLegalLead(this.sel, this.sel) && popcount(this.sel) <= v.oppCount, 'primary') + oppRaise;
      case Phase.Respond:
        if (v.toAct === ME) {
          const cnt = popcount(this.sel);
          const beatOk = cnt === n && canBeatAll(cardsOf(this.sel), cardsOf(v.lead), v.trumpSuit);
          return `<p>Answer the lead: beat all ${n} card${n > 1 ? 's' : ''} or give ${n} face down. Select your cards.</p>` +
            btn('my-beat', 'I beat with these', beatOk, 'primary') + btn('my-give', 'I gave these face down', cnt === n) + myRaise;
        }
        return `<p>What did the opponent do?</p>${btn('opp-give', `Gave ${n} card${n > 1 ? 's' : ''} face down`, true, 'primary')}` +
          `<p class="muted">…or tap the cards they beat with:</p>${pickerHtml(v.possibleOppCards(), this.sel, 'pick', v.trumpSuit)}` +
          btn('opp-beat', 'Opponent beat with these', popcount(this.sel) === n && canBeatAll(cardsOf(this.sel), cardsOf(v.lead), v.trumpSuit)) + oppRaise;
      case Phase.Claim:
        if (v.toAct === ME) return `<p>You won the trick.</p>${btn('my-claim', 'I said ვარ')}${btn('my-continue', 'I continued')}`;
        return `<p>The opponent won the trick.</p>${btn('opp-claim', 'Opponent said ვარ')}${btn('opp-continue', 'Opponent continued', true, 'primary')}`;
      case Phase.Raise:
        if (v.toAct === ME) {
          return `<p>The opponent raised to ${v.stake + 1}. Declining loses ${v.stake} now.</p>${btn('my-accept', 'I accepted')}${btn('my-decline', 'I declined')}`;
        }
        return `<p>You raised to ${v.stake + 1}. Did the opponent accept?</p>${btn('opp-accept', 'Accepted', true, 'primary')}${btn('opp-decline', 'Declined')}`;
    }
    return '';
  }

  handle(act: string, el: HTMLElement): void {
    this.message = '';
    const v = this.view;
    const card = Number(el.dataset.card);
    const cards = cardsOf(this.sel);
    switch (act) {
      case 'setup-trump':
        this.setupTrump = this.setupTrump === card ? -1 : card;
        break;
      case 'setup-hand':
        if (this.setupHand & (1 << card)) this.setupHand &= ~(1 << card);
        else if (popcount(this.setupHand) < 3) this.setupHand |= 1 << card;
        break;
      case 'setup-leader':
        this.setupLeader = Number((el as HTMLInputElement).value);
        break;
      case 'rule':
        this.rules = readRule(this.rules, el);
        break;
      case 'think':
        this.think = (el as HTMLSelectElement).value as Think;
        break;
      case 'start':
        this.history = [];
        this.auto = [];
        this.push({ t: 'deal', leader: this.setupLeader, trumpCard: this.setupTrump, hand: cardsOf(this.setupHand), rules: { ...this.rules } });
        return;
      case 'reset':
        if (this.view?.result) this.tally[this.view.result.winner] += this.view.result.points;
        this.history = null;
        this.view = null;
        this.setupTrump = -1;
        this.setupHand = 0;
        break;
      case 'undo':
        this.undo();
        return;
      case 'sel':
      case 'pick':
        this.sel ^= 1 << card;
        break;
      case 'draw': this.push({ t: 'draw', p: ME, card }); return;
      case 'my-lead': this.push({ t: 'lead', p: ME, cards }); return;
      case 'my-beat': this.push({ t: 'beat', p: ME, cards }); return;
      case 'my-give': this.push({ t: 'give', p: ME, count: cards.length, cards }); return;
      case 'opp-lead': this.push({ t: 'lead', p: OPP, cards }); return;
      case 'opp-beat': this.push({ t: 'beat', p: OPP, cards }); return;
      case 'opp-give': this.push({ t: 'give', p: OPP, count: popcount(v!.lead) }); return;
      case 'my-claim': this.push({ t: 'claim', p: ME }); return;
      case 'my-continue': this.push({ t: 'continue', p: ME }); return;
      case 'opp-claim': this.push({ t: 'claim', p: OPP }); return;
      case 'opp-continue': this.push({ t: 'continue', p: OPP }); return;
      case 'my-raise': this.push({ t: 'raise', p: ME }); return;
      case 'opp-raise': this.push({ t: 'raise', p: OPP }); return;
      case 'my-accept': this.push({ t: 'accept', p: ME }); return;
      case 'my-decline': this.push({ t: 'decline', p: ME }); return;
      case 'opp-accept': this.push({ t: 'accept', p: OPP }); return;
      case 'opp-decline': this.push({ t: 'decline', p: OPP }); return;
      case 'end-me':
      case 'end-opp': {
        const last = this.history![this.history!.length - 1];
        const winner = act === 'end-me' ? ME : OPP;
        const reason = last.t === 'claim' ? (last.p === winner ? 'claim' : 'wrong-claim') : 'exhausted';
        this.push({ t: 'end', winner, points: v!.stake, reason });
        return;
      }
    }
    this.update();
  }

  /** Adds an observation if it is consistent with everything so far, then fills in anything automatic. */
  private push(o: Obs, auto = false): boolean {
    try {
      this.view = PlayerView.from(ME, [...this.history!, o]);
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      this.update();
      return false;
    }
    this.history!.push(this.view.history[this.view.history.length - 1]);
    this.auto.push(auto);
    if (!auto) {
      this.sel = 0;
      this.autoAdvance();
      this.onChanged();
    }
    return true;
  }

  private autoAdvance(): void {
    for (;;) {
      const v = this.view!;
      if (v.phase === Phase.Draw && (v.pendingDraws[0] === OPP || v.stockCount === 1)) {
        this.push({ t: 'draw', p: v.pendingDraws[0] }, true);
      } else if (v.phase === Phase.Over && !v.result && this.history![this.history!.length - 1].t === 'decline') {
        this.push({ t: 'end', winner: v.raiser, points: v.stake, reason: 'declined' }, true);
      } else {
        break;
      }
    }
  }

  private undo(): void {
    const h = this.history!;
    if (h.length <= 1) return;
    while (h.length > 1 && this.auto[h.length - 1]) {
      h.pop();
      this.auto.pop();
    }
    if (h.length > 1) {
      h.pop();
      this.auto.pop();
    }
    this.view = PlayerView.from(ME, h);
    this.sel = 0;
    this.onChanged();
  }

  private onChanged(): void {
    this.analysis = null;
    this.error = '';
    const v = this.view!;
    const decision = v.toAct === ME && !v.over && DECISION_PHASES.includes(v.phase);
    this.loading = decision;
    const id = ++this.reqId;
    if (decision) {
      this.ai
        .analyze(ME, this.history!.slice(), { timeMs: THINK_MS[this.think] })
        .then((a) => {
          if (id !== this.reqId) return;
          this.analysis = a;
          this.loading = false;
          if (this.sel === 0 && a.cardAction >= 0) {
            const k = actKind(a.cardAction);
            if (k === K_LEAD || k === K_BEAT || k === K_GIVE) this.sel = a.cardAction & ALL_CARDS;
          }
          this.update();
        })
        .catch((err) => {
          if (id !== this.reqId) return;
          this.error = String(err);
          this.loading = false;
          this.update();
        });
    }
    this.update();
  }
}

function describe(o: Obs): string {
  const who = (p: number) => (p === ME ? 'You' : 'Opponent');
  switch (o.t) {
    case 'deal': return `Deal: trump ${cardName(o.trumpCard)}, your cards ${o.hand.map(cardName).join(' ')}; ${who(o.leader)} lead${o.leader === ME ? '' : 's'}.`;
    case 'lead': return `${who(o.p)} led ${o.cards.map(cardName).join(' ')}.`;
    case 'beat': return `${who(o.p)} beat with ${o.cards.map(cardName).join(' ')}.`;
    case 'give': return `${who(o.p)} gave ${o.cards ? o.cards.map(cardName).join(' ') : `${o.count} card(s)`} face down.`;
    case 'draw': return `${who(o.p)} drew ${o.card !== undefined ? cardName(o.card) : 'a card'}.`;
    case 'end': return `${who(o.winner)} won ${o.points} point(s) (${o.reason}).`;
    default: return `${who(o.p)}: ${o.t}.`;
  }
}
