import type { Analysis } from '../ai/advisor';
import { probReach } from '../ai/heuristic';
import { ALL_CARDS, cardName, cardsOf, maskName, popcount } from '../core/cards';
import { cryptoRng } from '../core/rng';
import { beatOptions, DEFAULT_RULES, raiseBlockedByScore, Rules } from '../core/rules';
import {
  ACCEPT, CLAIM, CONTINUE, DECLINE, K_BEAT, K_GIVE, K_LEAD, mkAct, Phase, RAISE, shuffledDeck,
} from '../core/state';
import { HandRunner, Obs } from '../core/view';
import { AiClient } from './aiClient';
import { analysisHtml, backsHtml, cardHtml, cardsHtml, esc, pct } from './common';

type Strength = 'easy' | 'normal' | 'hard';
const THINK_MS: Record<Strength, number> = { easy: 0, normal: 800, hard: 2500 };
const HUMAN = 0, AI = 1;
const who = (p: number): string => (p === HUMAN ? 'You' : 'AI');

interface TrickRecord {
  leader: number;
  lead: number;
  beat?: number;
  given?: number;
  givenCards?: number;
}

export class PlayController {
  private runner: HandRunner | null = null;
  private rules: Rules = { ...DEFAULT_RULES };
  private strength: Strength = 'normal';
  private match = [0, 0];
  private nextLeader = Math.random() < 0.5 ? 0 : 1;
  private selected = 0;
  private hints = false;
  private hint: Analysis | null = null;
  private hintLoading = false;
  private hintError = '';
  private aiBusy = false;
  /** Bumped on every new hand; stale AI replies are dropped. */
  private gen = 0;
  private hintGen = 0;
  private scored = false;
  private logged = 0;
  private log: string[] = [];
  private lastTrick: TrickRecord | null = null;
  private pendingLead: TrickRecord | null = null;
  private message = '';

  constructor(private ai: AiClient, private update: () => void) {}

  render(): string {
    let html = '<section class="play">';
    html += this.settingsHtml();
    if (!this.runner) {
      html += '<p class="intro">Play a match against the AI. It only sees its own cards, exactly like you. ';
      html += 'Turn on <b>Advisor hints</b> to see what the advisor would play in your seat.</p>';
      return html + '</section>';
    }
    const s = this.runner.state;
    const v = this.runner.view(HUMAN);
    const matchTo = s.rules.matchTo;
    html += `<div class="scoreboard"><span>${matchTo ? `First to ${matchTo}` : 'Match'}: <b>You ${this.match[0]}</b> – <b>AI ${this.match[1]}</b></span>`;
    html += `<span>Stake <b>${s.stake}</b>${s.raiseRight === -1 ? '' : ` · next raise: ${who(s.raiseRight)}`}</span></div>`;

    html += '<div class="seat opp"><div class="seat-label">AI</div>';
    html += `<div class="hand">${s.over ? cardsHtml(s.hands[AI], { trump: s.trumpSuit }) : backsHtml(popcount(s.hands[AI]))}</div>`;
    html += `<div class="pile">AI pile: <b>${v.oppPoints()}</b> points</div></div>`;

    html += '<div class="table">';
    html += `<div class="trump-slot"><div class="seat-label">Trump</div>${v.trumpInStock ? cardHtml(s.trumpCard, { trump: s.trumpSuit }) : `<div class="card ghost">${esc(cardName(s.trumpCard))}</div>`}`;
    html += `<div class="stock">Stock: ${s.stockCount}</div></div>`;
    html += `<div class="trick">${this.trickHtml()}</div></div>`;

    const myTurn = s.toAct === HUMAN && !this.aiBusy;
    const selectable = myTurn && (s.phase === Phase.Lead || s.phase === Phase.Respond);
    html += '<div class="seat me"><div class="seat-label">You</div><div class="hand">';
    html += cardsOf(s.hands[HUMAN])
      .map((c) => cardHtml(c, { trump: s.trumpSuit, act: selectable ? 'sel' : undefined, selected: (this.selected & (1 << c)) !== 0 }))
      .join('');
    html += `</div><div class="pile">Your pile: <b>${v.myKnownPoints()}</b> points you can see`;
    if (v.myHiddenCount) html += ` + <b>${v.myHiddenCount}</b> face-down card${v.myHiddenCount > 1 ? 's' : ''}`;
    html += '</div></div>';

    html += `<div class="actions">${this.actionsHtml()}</div>`;
    if (this.message) html += `<div class="message">${esc(this.message)}</div>`;
    if (s.over) html += this.resultHtml();
    if (this.hints && myTurn && !s.over) html += analysisHtml(this.hint, this.hintLoading, this.hintError);
    html += `<details class="log"><summary>Hand log</summary><ol>${this.log.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></details>`;
    return html + '</section>';
  }

  private settingsHtml(): string {
    const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    let h = '<div class="settings">';
    h += `<label>AI strength <select data-change="strength">${opt('easy', 'Easy (rules of thumb)', this.strength)}${opt('normal', 'Normal (0.8s search)', this.strength)}${opt('hard', 'Hard (2.5s search)', this.strength)}</select></label>`;
    h += `<label><input type="checkbox" data-change="hints"${this.hints ? ' checked' : ''}> Advisor hints</label>`;
    h += modeHtml(this.rules);
    h += `<details><summary>Rules</summary>${rulesFormHtml(this.rules)}</details>`;
    h += `<button type="button" data-act="new-match">${this.runner ? 'New match' : 'Start match'}</button>`;
    return h + '</div>';
  }

  private trickHtml(): string {
    const s = this.runner!.state;
    if (s.phase === Phase.Respond || (s.phase === Phase.Raise && s.lead)) {
      return `<div class="trick-line"><span class="seat-label">${who(s.leader)} led</span>${cardsHtml(s.lead, { trump: s.trumpSuit })}</div>`;
    }
    const t = this.lastTrick;
    if (!t) return '<div class="trick-empty">No cards on the table</div>';
    let h = `<div class="trick-line last"><span class="seat-label">Last trick: ${who(t.leader)} led</span>${cardsHtml(t.lead, { trump: s.trumpSuit, small: true })}</div>`;
    const d = 1 - t.leader;
    if (t.beat !== undefined) {
      h += `<div class="trick-line last"><span class="seat-label">${who(d)} beat with</span>${cardsHtml(t.beat, { trump: s.trumpSuit, small: true })}<span class="taker">→ ${who(d)} take${d === HUMAN ? '' : 's'} it</span></div>`;
    } else {
      const shown = t.givenCards ? cardsHtml(t.givenCards, { trump: s.trumpSuit, small: true }) : backsHtml(t.given ?? 0, true);
      h += `<div class="trick-line last"><span class="seat-label">${who(d)} gave face down</span>${shown}<span class="taker">→ ${who(t.leader)} take${t.leader === HUMAN ? '' : 's'} it</span></div>`;
    }
    return h;
  }

  private actionsHtml(): string {
    const s = this.runner!.state;
    if (s.over) return '';
    if (this.aiBusy) return '<div class="thinking">AI is thinking…</div>';
    if (s.toAct !== HUMAN) return '';
    const v = this.runner!.view(HUMAN);
    const btn = (act: string, label: string, enabled = true, cls = '') =>
      `<button type="button" class="${cls}" data-act="${act}"${enabled ? '' : ' disabled'}>${esc(label)}</button>`;
    const legal = s.legal();
    const raise = legal.includes(RAISE)
      ? btn('raise', `Raise stake to ${s.stake + 1}`, true, 'secondary')
      : raiseBlockedByScore(s.rules, s.matchScore, HUMAN) && (s.phase === Phase.Lead || s.phase === Phase.Respond)
        ? `<span class="muted">No raising while you trail 0–${s.rules.matchTo - 1}.</span>`
        : '';
    const sel = this.selected;
    switch (s.phase) {
      case Phase.Lead:
        return `<span class="prompt">Your lead: select 1–3 cards of one suit.</span>${btn('lead', 'Lead', legal.includes(mkAct(K_LEAD, sel)), 'primary')}${raise}`;
      case Phase.Respond: {
        const n = popcount(s.lead);
        const beats = beatOptions(s.hands[HUMAN], s.lead, s.trumpSuit);
        const hint = beats.length ? `You can beat with: ${beats.map(maskName).join(' | ')}` : 'You cannot beat this.';
        return `<span class="prompt">Beat all ${n} card${n > 1 ? 's' : ''} or give ${n} face down. ${esc(hint)}</span>` +
          btn('beat', 'Beat and take the trick', legal.includes(mkAct(K_BEAT, sel)), 'primary') +
          btn('give', 'Give face down', legal.includes(mkAct(K_GIVE, sel))) + raise;
      }
      case Phase.Claim: {
        const p = probReach(v.myKnownPoints(), v.myHiddenCount, v.unknownMask());
        return `<span class="prompt">You won the trick. Chance your pile is 31+: ~${pct(p)}${v.myHiddenCount ? ' (you cannot see the face-down cards)' : ''}.</span>` +
          btn('claim', 'ვარ! (claim 31+)', true, 'primary') + btn('continue', 'Continue');
      }
      case Phase.Raise:
        return `<span class="prompt">The AI raises to ${s.stake + 1}. Declining loses ${s.stake} point${s.stake > 1 ? 's' : ''} now.</span>` +
          btn('accept', `Accept (play for ${s.stake + 1})`, true, 'primary') + btn('decline', `Decline (lose ${s.stake})`);
    }
    return '';
  }

  private resultHtml(): string {
    const s = this.runner!.state;
    const reasons: Record<string, string> = {
      claim: 'correct ვარ', 'wrong-claim': 'wrong ვარ', declined: 'raise declined', exhausted: 'all cards played', bura: 'ბურა (three trumps)',
    };
    let h = `<div class="result ${s.winner === HUMAN ? 'win' : 'loss'}"><h3>${s.winner === HUMAN ? 'You win' : 'AI wins'} ${s.stake} point${s.stake > 1 ? 's' : ''} — ${reasons[s.reason] ?? s.reason}</h3>`;
    for (const p of [HUMAN, AI]) {
      h += `<div class="pile-reveal"><span class="seat-label">${p === HUMAN ? 'Your' : 'AI'} pile: ${s.score(p)} points</span>`;
      h += cardsOf(s.piles[p]).map((c) => cardHtml(c, { trump: s.trumpSuit, small: true, title: (s.hidden[p] >> c) & 1 ? 'given face down' : undefined })).join('');
      h += '</div>';
    }
    const matchTo = s.rules.matchTo;
    if (matchTo && Math.max(...this.match) >= matchTo) {
      const won = this.match[HUMAN] >= matchTo;
      h += `<h3>${won ? 'You win the match' : 'The AI wins the match'} ${this.match[HUMAN]}–${this.match[AI]}</h3>`;
      return h + '<button type="button" class="primary" data-act="new-match">New match</button></div>';
    }
    return h + '<button type="button" class="primary" data-act="next-hand">Next hand</button></div>';
  }

  handle(act: string, el: HTMLElement): void {
    this.message = '';
    switch (act) {
      case 'new-match':
        this.match = [0, 0];
        this.startHand();
        return;
      case 'next-hand':
        this.startHand();
        return;
      case 'strength':
        this.strength = (el as HTMLSelectElement).value as Strength;
        break;
      case 'hints':
        this.hints = (el as HTMLInputElement).checked;
        this.requestHint();
        break;
      case 'rule': {
        const before = this.rules.matchTo;
        this.rules = readRule(this.rules, el);
        if (this.rules.matchTo !== before) {
          // A different scoring mode is a different match.
          this.gen++;
          this.runner = null;
          this.match = [0, 0];
          this.aiBusy = false;
        }
        break;
      }
      case 'sel':
        this.selected ^= 1 << Number(el.dataset.card);
        break;
      case 'lead': this.humanAct(mkAct(K_LEAD, this.selected)); return;
      case 'beat': this.humanAct(mkAct(K_BEAT, this.selected)); return;
      case 'give': this.humanAct(mkAct(K_GIVE, this.selected)); return;
      case 'claim': this.humanAct(CLAIM); return;
      case 'continue': this.humanAct(CONTINUE); return;
      case 'raise': this.humanAct(RAISE); return;
      case 'accept': this.humanAct(ACCEPT); return;
      case 'decline': this.humanAct(DECLINE); return;
    }
    this.update();
  }

  private startHand(): void {
    this.gen++;
    this.runner = new HandRunner(shuffledDeck(cryptoRng()), this.nextLeader, { ...this.rules }, [this.match[0], this.match[1]]);
    this.logged = 0;
    this.log = [];
    this.lastTrick = this.pendingLead = null;
    this.selected = 0;
    this.aiBusy = false;
    this.scored = false;
    this.afterChange();
  }

  private humanAct(a: number): void {
    const s = this.runner!.state;
    if (s.toAct !== HUMAN || this.aiBusy || !s.isLegal(a)) {
      this.message = 'That move is not allowed.';
      this.update();
      return;
    }
    this.runner!.act(a);
    this.selected = 0;
    this.afterChange();
  }

  private afterChange(): void {
    const run = this.runner!;
    this.consumeLog(run.obs[HUMAN]);
    this.hint = null;
    this.hintError = '';
    if (run.state.over) {
      if (!this.scored) {
        this.scored = true;
        this.match[run.state.winner] += run.state.stake;
        this.nextLeader = 1 - run.state.winner;
      }
    } else if (run.state.toAct === AI) {
      void this.runAi();
    } else {
      this.requestHint();
    }
    this.update();
  }

  private async runAi(): Promise<void> {
    const gen = this.gen;
    const run = this.runner!;
    this.aiBusy = true;
    this.update();
    const started = performance.now();
    let action: number;
    try {
      const view = run.view(AI);
      action = this.strength === 'easy'
        ? await this.ai.heuristicMove(AI, view.history)
        : (await this.ai.analyze(AI, view.history, { timeMs: THINK_MS[this.strength] })).action;
    } catch (err) {
      this.message = `AI error: ${err instanceof Error ? err.message : err}`;
      this.aiBusy = false;
      this.update();
      return;
    }
    const wait = 600 - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (gen !== this.gen) return;
    this.aiBusy = false;
    run.act(action);
    this.afterChange();
  }

  private requestHint(): void {
    const run = this.runner;
    if (!this.hints || !run || run.state.over || run.state.toAct !== HUMAN) return;
    const gen = ++this.hintGen;
    this.hintLoading = true;
    const history = run.view(HUMAN).history.slice();
    this.ai
      .analyze(HUMAN, history, { timeMs: 1200 })
      .then((a) => {
        if (gen !== this.hintGen || run !== this.runner) return;
        this.hint = a;
        this.hintLoading = false;
        if (a.cardAction >= 0 && this.selected === 0) this.selected = a.cardAction & ALL_CARDS;
        this.update();
      })
      .catch((err) => {
        if (gen !== this.hintGen) return;
        this.hintError = String(err);
        this.hintLoading = false;
        this.update();
      });
  }

  private consumeLog(obs: Obs[]): void {
    for (; this.logged < obs.length; this.logged++) {
      const o = obs[this.logged];
      switch (o.t) {
        case 'deal':
          this.log.push(`New hand. Trump ${cardName(o.trumpCard)}. ${who(o.leader)} lead${o.leader === HUMAN ? '' : 's'}.`);
          break;
        case 'lead':
          this.pendingLead = { leader: o.p, lead: maskOf(o.cards) };
          this.log.push(`${who(o.p)} led ${o.cards.map(cardName).join(' ')}.`);
          break;
        case 'beat':
          this.lastTrick = { ...this.pendingLead!, beat: maskOf(o.cards) };
          this.log.push(`${who(o.p)} beat with ${o.cards.map(cardName).join(' ')} and took the trick.`);
          break;
        case 'give':
          this.lastTrick = { ...this.pendingLead!, given: o.count, givenCards: o.cards ? maskOf(o.cards) : undefined };
          this.log.push(`${who(o.p)} gave ${o.cards ? o.cards.map(cardName).join(' ') : `${o.count} card${o.count > 1 ? 's' : ''}`} face down.`);
          break;
        case 'claim': this.log.push(`${who(o.p)} said ვარ!`); break;
        case 'continue': this.log.push(`${who(o.p)} continued.`); break;
        case 'raise': this.log.push(`${who(o.p)} raised the stake.`); break;
        case 'accept': this.log.push(`${who(o.p)} accepted.`); break;
        case 'decline': this.log.push(`${who(o.p)} declined.`); break;
        case 'draw':
          if (o.card !== undefined) this.log.push(`${who(o.p)} drew ${cardName(o.card)}${o.p === AI ? ' (the trump card)' : ''}.`);
          break;
        case 'end':
          this.log.push(`${who(o.winner)} won ${o.points} point${o.points > 1 ? 's' : ''} (${o.reason}).`);
          break;
      }
    }
  }
}

function maskOf(cards: number[]): number {
  return cards.reduce((m, c) => m | (1 << c), 0);
}

/** Scoring mode selector: unlimited points or a match to 3. */
export function modeHtml(r: Rules): string {
  const opt = (v: number, label: string) => `<option value="${v}"${r.matchTo === v ? ' selected' : ''}>${label}</option>`;
  return `<label>Mode <select data-change="rule" data-rule="matchTo">${opt(0, 'Points (no limit)')}${opt(3, 'First to 3')}</select></label>`;
}

export function rulesFormHtml(r: Rules): string {
  return `<div class="rules-form">
    <label>Max stake <input type="number" min="1" max="20" value="${r.maxStake}" data-change="rule" data-rule="maxStake"></label>
    <label><input type="checkbox" data-change="rule" data-rule="defenderMayRaise"${r.defenderMayRaise ? ' checked' : ''}> Defender may raise after seeing the lead</label>
    <label><input type="checkbox" data-change="rule" data-rule="buraWins"${r.buraWins ? ' checked' : ''}> Three trumps (ბურა) wins instantly</label>
  </div>`;
}

export function readRule(r: Rules, el: HTMLElement): Rules {
  const input = el as HTMLInputElement;
  const key = el.dataset.rule as keyof Rules;
  if (key === 'maxStake') return { ...r, maxStake: Math.max(1, Math.min(20, Number(input.value) || 1)) };
  if (key === 'matchTo') return { ...r, matchTo: Number(input.value) || 0 };
  return { ...r, [key]: input.checked };
}
