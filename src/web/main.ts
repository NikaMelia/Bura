import './style.css';
import { AdvisorController } from './advisorView';
import { AiClient } from './aiClient';
import { PlayController } from './play';

interface Controller {
  render(): string;
  handle(act: string, el: HTMLElement): void;
}

type Tab = 'advisor' | 'play' | 'rules';

const app = document.getElementById('app')!;
const ai = new AiClient();
let tab: Tab = (location.hash.slice(1) as Tab) || 'advisor';
if (!['advisor', 'play', 'rules'].includes(tab)) tab = 'advisor';

let scheduled = false;
const update = (): void => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
};

const controllers: Record<'advisor' | 'play', Controller> = {
  advisor: new AdvisorController(ai, update),
  play: new PlayController(ai, update),
};

function render(): void {
  const openDetails = [...app.querySelectorAll('details[open] > summary')].map((s) => s.textContent);
  const tabs = (['advisor', 'play', 'rules'] as Tab[])
    .map((t) => `<button type="button" class="tab${t === tab ? ' active' : ''}" data-tab="${t}">${{ advisor: 'Advisor', play: 'Play vs AI', rules: 'Rules & AI' }[t]}</button>`)
    .join('');
  const body = tab === 'rules' ? RULES_HTML : controllers[tab].render();
  app.innerHTML = `<header><h1>ბურა <span>Bura</span></h1><nav>${tabs}</nav></header><main>${body}</main>`;
  for (const s of app.querySelectorAll('details > summary')) {
    if (openDetails.includes(s.textContent)) (s.parentElement as HTMLDetailsElement).open = true;
  }
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  if (el.dataset.tab) {
    tab = el.dataset.tab as Tab;
    history.replaceState(null, '', `#${tab}`);
    render();
    return;
  }
  if (tab !== 'rules') controllers[tab].handle(el.dataset.act!, el);
});

app.addEventListener('change', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-change]');
  if (el && tab !== 'rules') controllers[tab].handle(el.dataset.change!, el);
});

const RULES_HTML = `<section class="rules">
<h2>Rules (as implemented)</h2>
<ul>
  <li><b>Deck:</b> 20 cards — J Q K 10 A in four suits. Points J 2, Q 3, K 4, 10 10, A 11 (120 in total). Rank A &gt; 10 &gt; K &gt; Q &gt; J.</li>
  <li><b>Deal:</b> 3 cards each, alternately from the leader. The next card is turned up as trump and goes to the bottom of the 14-card stock (drawn last).</li>
  <li><b>Trick:</b> the leader plays 1–3 cards of one suit. The defender either <b>beats every card</b> (each by a higher card of its suit, or by a trump against a non-trump) and takes the trick face up, or <b>gives the same number of cards face down</b> — the leader takes the trick without seeing them.</li>
  <li>So you always know the opponent's exact score, but not your own.</li>
  <li>The trick winner leads next and draws first; both refill to 3 one card at a time.</li>
  <li><b>ვარ:</b> right after winning a trick you may claim 31+. Right: you win the hand at the current stake. Wrong: you lose it. Continuing is final for that trick. If every card is played, the last trick winner's claim is forced.</li>
  <li><b>Raising:</b> on your turn you may raise. Declined → the raiser wins the current stake. Accepted → stake +1, and only the accepter may raise next.</li>
  <li><b>First to 3</b> mode: the first player to 3 points wins the match, and a player trailing 0–2 may not raise.</li>
  <li>Options (Rules panel): stake cap (default 8), whether the defender may raise after seeing the lead (default yes), three trumps (ბურა) winning instantly (default off).</li>
</ul>
<h2>How the AI decides</h2>
<ol>
  <li><b>It only uses what you know.</b> Its input is the list of things you have seen: your cards, what was played face up, how many cards went face down, what you drew.</li>
  <li><b>It imagines the hidden cards.</b> It samples hundreds of complete deals consistent with that history — the opponent's hand, the stock order, the face-down cards in your pile — and even rebuilds when the opponent drew and gave each card.</li>
  <li><b>It reads the opponent.</b> Each sampled deal is replayed from the start and weighted by how likely the opponent's actual choices were in it. If they gave cards instead of beating your 10, deals where they could beat it cheaply become less likely.</li>
  <li><b>It searches.</b> Information-Set Monte Carlo Tree Search (ISMCTS) plays thousands of simulated continuations across those deals, building one tree of <i>your</i> information sets, so a move is judged by how it does across all the deals you cannot tell apart — not by peeking at one of them. Each simulated continuation is finished by an exact solver.</li>
  <li><b>Claims (ვარ)</b> are judged from the same weighted deals: the chance your face-down cards push you to 31, against the value of playing on.</li>
  <li><b>Raises</b> use the win chance: raise at ≥70%; accept a raise when the chance is above 1/(2·(stake+1)) plus a safety margin (the break-even point of accepting). In <b>first to 3</b> it compares chances of winning the whole match instead, so it never raises at 2–2 or when leading 2–0.</li>
</ol>
<p class="muted">Random deals use the browser's cryptographic random generator. Nothing leaves your device: the AI runs in your browser.</p>
</section>`;

render();
