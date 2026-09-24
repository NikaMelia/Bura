import type { Analysis } from '../ai/advisor';
import { Card, cardName, cardsOf, maskName, rankOf, RANK_NAMES, suitOf, SUIT_SYMBOLS } from '../core/cards';
import { actKind, actMask, K_ACCEPT, K_BEAT, K_CLAIM, K_CONTINUE, K_DECLINE, K_GIVE, K_LEAD, K_RAISE } from '../core/state';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export interface CardOpts {
  trump?: number;
  selected?: boolean;
  act?: string;
  disabled?: boolean;
  small?: boolean;
  title?: string;
}

export function cardHtml(c: Card, o: CardOpts = {}): string {
  const s = suitOf(c);
  const cls = ['card', s === 1 || s === 2 ? 'red' : 'black'];
  if (o.trump === s) cls.push('trump');
  if (o.selected) cls.push('selected');
  if (o.small) cls.push('small');
  if (o.disabled) cls.push('disabled');
  const tag = o.act && !o.disabled ? 'button' : 'div';
  const attrs = o.act && !o.disabled ? ` data-act="${o.act}" data-card="${c}" type="button"` : '';
  const title = o.title ? ` title="${esc(o.title)}"` : '';
  return `<${tag} class="${cls.join(' ')}"${attrs}${title}><span class="rank">${RANK_NAMES[rankOf(c)]}</span><span class="suit">${SUIT_SYMBOLS[s]}</span></${tag}>`;
}

export function cardsHtml(mask: number, o: CardOpts = {}): string {
  return cardsOf(mask).map((c) => cardHtml(c, o)).join('');
}

export function backsHtml(n: number, small = false): string {
  return Array.from({ length: n }, () => `<div class="card back${small ? ' small' : ''}"></div>`).join('');
}

/** 4x5 grid of every card for entering what happened at a real table. */
export function pickerHtml(allowed: number, selected: number, act: string, trump?: number): string {
  let html = '<div class="picker">';
  for (let s = 0; s < 4; s++) {
    html += '<div class="picker-row">';
    for (let r = 4; r >= 0; r--) {
      const c = s * 5 + r;
      html += cardHtml(c, { trump, act, selected: (selected & (1 << c)) !== 0, disabled: (allowed & (1 << c)) === 0, small: true });
    }
    html += '</div>';
  }
  return html + '</div>';
}

export function actionLabel(a: number): string {
  const m = actMask(a);
  switch (actKind(a)) {
    case K_LEAD: return `Lead ${maskName(m)}`;
    case K_BEAT: return `Beat with ${maskName(m)}`;
    case K_GIVE: return `Give ${maskName(m)} face down`;
    case K_CLAIM: return 'Say ვარ (claim 31+)';
    case K_CONTINUE: return 'Continue playing';
    case K_RAISE: return 'Raise the stake';
    case K_ACCEPT: return 'Accept the raise';
    case K_DECLINE: return 'Decline the raise';
  }
  return '?';
}

export const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** The advisor's recommendation with the evidence behind it. */
export function analysisHtml(a: Analysis | null, loading: boolean, error?: string): string {
  if (error) return `<div class="analysis error">${esc(error)}</div>`;
  if (loading && !a) return '<div class="analysis"><div class="thinking">Thinking…</div></div>';
  if (!a) return '';
  const r = a.search;
  let head = '';
  if (a.decision === 'raise-response') {
    head = `${actionLabel(a.action)}`;
  } else if (a.raiseRecommended) {
    const next = actionLabel(a.cardAction);
    head = `Raise the stake, then ${next[0].toLowerCase()}${next.slice(1)}`;
  } else {
    head = actionLabel(a.action);
  }
  let html = `<div class="analysis${loading ? ' stale' : ''}">`;
  html += `<div class="best"><span class="label">Best move</span><span class="move">${esc(head)}</span>`;
  html += `<span class="win">Win chance ${pct(a.winProb)}</span></div>`;

  if (a.decision === 'raise-response') {
    html += `<p class="note">Accepting pays off when your win chance is at least ${pct(a.acceptThreshold ?? 0)} at this stake.</p>`;
  }
  if (a.decision === 'claim') {
    html += `<p class="note">Chance your pile is worth 31+: <b>${pct(r.claimProb)}</b> · expected pile ${r.expectedScore.toFixed(1)} points</p>`;
  }
  if (a.canRaise) {
    const why = a.matchWinProb === undefined ? 'raise at ≥70% win chance' : 'judged by the match score';
    html += `<p class="note">Raise: ${a.raiseRecommended ? '<b>yes</b>' : 'not now'} (${why})</p>`;
  }
  if (a.matchWinProb !== undefined) {
    html += `<p class="note">Chance to win the match: <b>${pct(a.matchWinProb)}</b> (later hands counted as even)</p>`;
  }

  if (r.actions.length > 1) {
    const total = r.actions.reduce((s, x) => s + x.visits, 0) || 1;
    html += '<table class="options"><thead><tr><th>Option</th><th>Win</th><th>Search share</th></tr></thead><tbody>';
    for (const s of r.actions) {
      const isBest = s.action === (a.decision === 'lead' || a.decision === 'respond' ? a.cardAction : a.search.best);
      html += `<tr class="${isBest ? 'top' : ''}"><td>${esc(actionLabel(s.action))}</td><td>${pct(s.winRate)}</td>`;
      html += `<td><div class="bar"><div style="width:${(100 * s.visits) / total}%"></div></div></td></tr>`;
    }
    html += '</tbody></table>';
  }

  const likely = r.oppCardProb
    .map((p, c) => ({ c, p }))
    .filter((x) => x.p > 0.001)
    .sort((x, y) => y.p - x.p)
    .slice(0, 8);
  if (likely.length) {
    html += '<div class="likely"><span class="label">Opponent probably holds</span>';
    html += likely.map((x) => `<span class="chip">${cardName(x.c)} ${pct(x.p)}</span>`).join('');
    html += '</div>';
  }
  html += `<div class="meta">${r.iterations.toLocaleString()} simulations · ${r.worlds} sampled deals (effective ${r.ess.toFixed(0)}) · ${(r.ms / 1000).toFixed(1)}s</div>`;
  return html + '</div>';
}
