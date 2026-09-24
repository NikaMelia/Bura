import { describe, expect, it } from 'vitest';
import { maskPoints, parseCard, popcount } from '../src/core/cards';
import { beatOptions, beats, DEFAULT_RULES } from '../src/core/rules';
import {
  ACCEPT, CLAIM, CONTINUE, DECLINE, GameState, K_BEAT, K_GIVE, K_LEAD, mkAct, Phase, RAISE, shuffledDeck,
} from '../src/core/state';
import { seededRng } from '../src/core/rng';
import { m, makeDeck, makeState } from './helpers';

describe('deck and deal', () => {
  it('has 20 cards worth 120 points', () => {
    expect(maskPoints(0xfffff)).toBe(120);
  });

  it('deals 3 cards each, leader first, and puts the trump card at the bottom of a 14-card stock', () => {
    const s = makeState('As Ks Qs', 'Ah Kh Qh', 'Jd', 'Ad', {}, 1);
    expect(s.hands[1]).toBe(m('As Ks Qs'));
    expect(s.hands[0]).toBe(m('Ah Kh Qh'));
    expect(s.trumpSuit).toBe(2);
    expect(s.stockCount).toBe(14);
    expect(s.stock[s.stock.length - 1]).toBe(parseCard('Jd'));
    expect(s.stock[0]).toBe(parseCard('Ad'));
    expect(s.toAct).toBe(1);
  });
});

describe('beating', () => {
  const trump = 3; // clubs
  it('higher card of the same suit beats, lower does not', () => {
    expect(beats(parseCard('As'), parseCard('10s'), trump)).toBe(true);
    expect(beats(parseCard('Ks'), parseCard('10s'), trump)).toBe(false);
  });
  it('any trump beats a non-trump; a non-trump never beats a different suit', () => {
    expect(beats(parseCard('Jc'), parseCard('As'), trump)).toBe(true);
    expect(beats(parseCard('Ah'), parseCard('Js'), trump)).toBe(false);
    expect(beats(parseCard('Ah'), parseCard('Jc'), trump)).toBe(false);
  });
  it('multi-card leads need a one-to-one matching', () => {
    // Led A♠ K♠; hand Q♣ J♣ 10♠: two trumps beat both, 10♠ beats neither A♠ nor... K♠ yes.
    const opts = beatOptions(m('Qc Jc 10s'), m('As Ks'), trump);
    expect(opts.sort()).toEqual([m('Qc Jc'), m('Qc 10s'), m('Jc 10s')].sort());
    // One trump cannot cover two led cards.
    expect(beatOptions(m('Qc Jh Jd'), m('As Ks'), trump)).toEqual([]);
  });
});

describe('tricks', () => {
  it('leads must be one suit', () => {
    const s = makeState('As Ks Qh', 'Ah Kh Jh', 'Jd');
    const leads = s.legal().filter((a) => a >>> 20 === K_LEAD).map((a) => a & 0xfffff);
    expect(leads).toContain(m('As Ks'));
    expect(leads).not.toContain(m('As Qh'));
    expect(leads).toHaveLength(4);
  });

  it('beating takes the trick face up and the defender leads next', () => {
    const s = makeState('Ks Qh Jh', 'As Kh 10h', 'Jd');
    s.apply(mkAct(K_LEAD, m('Ks')));
    s.apply(mkAct(K_BEAT, m('As')));
    expect(s.piles[1]).toBe(m('Ks As'));
    expect(s.hidden[1]).toBe(0);
    expect(s.phase).toBe(Phase.Claim);
    expect(s.toAct).toBe(1);
  });

  it('giving puts the cards face down in the leader pile; the leader never sees them', () => {
    const s = makeState('Ks Qh Jh', 'As Kh 10h', 'Jd');
    s.apply(mkAct(K_LEAD, m('Qh Jh')));
    s.apply(mkAct(K_GIVE, m('As 10h')));
    expect(s.piles[0]).toBe(m('Qh Jh As 10h'));
    expect(s.hidden[0]).toBe(m('As 10h'));
    expect(s.seen[0] & m('As 10h')).toBe(0);
    expect(s.toAct).toBe(0);
  });

  it('cannot beat with the wrong number of cards and must give as many as were led', () => {
    const s = makeState('Ks Qs Jh', 'As 10s Kh', 'Jd');
    s.apply(mkAct(K_LEAD, m('Ks Qs')));
    for (const a of s.legal()) {
      if (a >>> 20 === K_BEAT || a >>> 20 === K_GIVE) expect(popcount(a & 0xfffff)).toBe(2);
    }
    expect(s.legal()).toContain(mkAct(K_BEAT, m('As 10s')));
  });

  it('the winner draws first and the trump card is drawn last', () => {
    const s = makeState('Ks Qh Jh', 'As Kh 10h', 'Jd', 'Ac 10c');
    s.apply(mkAct(K_LEAD, m('Ks')));
    s.apply(mkAct(K_BEAT, m('As')));
    s.apply(CONTINUE);
    expect(s.hands[1] & m('Ac')).toBeTruthy();
    expect(s.hands[0] & m('10c')).toBeTruthy();
    expect(s.stockCount).toBe(12);

    const t = GameState.deal(shuffledDeck(seededRng(3)), 0, DEFAULT_RULES);
    let last = -1;
    while (!t.over) {
      const acts = t.legal().filter((a) => a !== RAISE && a !== CLAIM);
      const a = acts[0];
      t.apply(a);
      if (a === CONTINUE && t.drawLog.length) last = t.drawLog[t.drawLog.length - 1] & 31;
    }
    expect(last).toBe(t.trumpCard);
  });
});

describe('claims (ვარ)', () => {
  it('a correct claim wins the hand at the current stake', () => {
    const s = makeState('As 10s Ks', 'Js Qh Jh', 'Jd');
    s.apply(mkAct(K_LEAD, m('As 10s Ks'))); // 25 points
    s.apply(mkAct(K_GIVE, m('Js Qh Jh'))); // +7 = 32
    s.apply(CLAIM);
    expect(s.winner).toBe(0);
    expect(s.reason).toBe('claim');
    expect(s.stake).toBe(1);
  });

  it('a wrong claim loses the hand', () => {
    const s = makeState('As Ks Qh', 'Js Jh 10h', 'Jd');
    s.apply(mkAct(K_LEAD, m('As Ks')));
    s.apply(mkAct(K_GIVE, m('Js Jh')));
    s.apply(CLAIM);
    expect(s.winner).toBe(1);
    expect(s.reason).toBe('wrong-claim');
  });

  it('when all cards are played the last trick winner claims by force', () => {
    const rng = seededRng(11);
    for (let g = 0; g < 50; g++) {
      const s = GameState.deal(shuffledDeck(rng), g % 2, DEFAULT_RULES);
      while (!s.over) s.apply(s.phase === Phase.Claim ? CONTINUE : s.legal().filter((a) => a !== RAISE)[0]);
      expect(s.reason).toBe('exhausted');
      const w = s.lastWinner;
      expect(s.winner).toBe(s.score(w) >= 31 ? w : 1 - w);
      expect(s.score(0) + s.score(1)).toBe(120);
    }
  });
});

describe('raising the stake', () => {
  it('declining gives the raiser the current stake', () => {
    const s = makeState('As Ks Qh', 'Js Jh 10h', 'Jd');
    s.apply(RAISE);
    expect(s.phase).toBe(Phase.Raise);
    s.apply(DECLINE);
    expect(s.winner).toBe(0);
    expect(s.stake).toBe(1);
    expect(s.reason).toBe('declined');
  });

  it('accepting adds one and only the acceptor may raise next', () => {
    const s = makeState('As Ks Qh', 'Js Jh 10h', 'Jd');
    s.apply(RAISE);
    s.apply(ACCEPT);
    expect(s.stake).toBe(2);
    expect(s.toAct).toBe(0);
    expect(s.legal()).not.toContain(RAISE);
    s.apply(mkAct(K_LEAD, m('As')));
    expect(s.legal()).toContain(RAISE); // defender (the acceptor) may raise after seeing the lead
    s.apply(RAISE);
    s.apply(ACCEPT);
    expect(s.stake).toBe(3);
    expect(s.phase).toBe(Phase.Respond);
    expect(s.toAct).toBe(1);
    expect(s.legal()).not.toContain(RAISE);
  });

  it('respects the stake cap and the defender-raise option', () => {
    const s = makeState('As Ks Qh', 'Js Jh 10h', 'Jd', '', { maxStake: 2, defenderMayRaise: false });
    s.apply(mkAct(K_LEAD, m('As')));
    expect(s.legal()).not.toContain(RAISE);
    const t = makeState('As Ks Qh', 'Js Jh 10h', 'Jd', '', { maxStake: 2 });
    t.apply(RAISE);
    t.apply(ACCEPT);
    t.apply(mkAct(K_LEAD, m('As')));
    expect(t.legal()).not.toContain(RAISE);
  });
});

describe('bura (three trumps)', () => {
  it('is off by default and wins instantly when enabled', () => {
    const deck = makeDeck('Ad 10d Kd', 'Js Jh 10h', 'Jd');
    expect(GameState.deal(deck, 0, DEFAULT_RULES).over).toBe(false);
    const s = GameState.deal(deck, 0, { ...DEFAULT_RULES, buraWins: true });
    expect(s.winner).toBe(0);
    expect(s.reason).toBe('bura');
  });
});
