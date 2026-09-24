# ბურა (Bura)

A rules engine, a move **advisor** for real games, and an **AI opponent** for Georgian 3-card Bura.
Everything runs in the browser (no server), so it works on a phone at the table.

- **Advisor**: at a real game, enter the trump card and your 3 cards, then tap in what happens as it
  happens (what the opponent led or beat with, how many cards they gave face down, what you drew,
  raises, claims). For every decision you face it shows the best move, the win chance of each option,
  the chance your pile is already 31+, whether to raise or accept a raise, and which cards the
  opponent probably holds. Undo fixes any mistyped step.
- **Play vs AI**: play against the same algorithm. It sees only its own cards, just like you.
  Turn on *Advisor hints* to see what the advisor would play in your seat.
- **Rules & AI**: the rules as implemented and a plain-language description of the algorithm.

```bash
npm install
npm run dev          # open the printed URL (use --host to reach it from a phone on the same Wi-Fi)
npm test             # rules, views, determinization, solver and AI tests
npm run build        # static site in dist/ (can be hosted anywhere, e.g. GitHub Pages)
npm run bench -- --a ismcts --b heuristic --deals 300 --iters 2000   # self-play benchmark
```

## Rules as implemented

- **Deck:** 20 cards — J Q K 10 A in four suits. Points J 2, Q 3, K 4, 10 10, A 11 (120 total).
  Rank A > 10 > K > Q > J.
- **Deal:** 3 cards each, alternately starting with the leader. The next card is turned up as trump
  and sits at the bottom of the 14-card stock (drawn last).
- **Trick:** the leader plays 1–3 cards of one suit. The defender either **beats every led card**
  (each with a higher card of the same suit, or a trump against a non-trump) and takes the trick face
  up, or **gives the same number of any cards face down**. The leader takes the trick without seeing
  them. So each player knows the opponent's exact score but not their own.
- The trick winner leads next and draws first; both refill to 3 one card at a time.
- **ვარ (claim 31+):** only the winner of the trick just played may claim, right after the trick.
  Correct → wins the hand at the current stake; wrong → loses it. Continuing is final for that trick.
- **Raising:** on your turn you may propose a raise. Declined → the proposer wins the current stake.
  Accepted → stake +1 and play continues; only the player who accepted may propose the next raise.

Assumptions not yet confirmed (configurable in the *Rules* panel):

1. The defender may also raise after seeing the lead (default **on**).
2. When every card has been played with no claim, the last trick winner's claim is forced.
3. Three trumps in hand (ბურა) winning instantly is implemented but **off** by default.
4. Stake cap, default 8.

## How the advisor decides

The hard part of Bura is hidden information: you don't see the opponent's hand, the stock order, or
the cards given to you face down (so you don't even know your own score). The advisor handles this in
four layers.

1. **Information set only.** The AI's input is the list of observations one player has made
   (`src/core/view.ts`), built the same way from the engine (vs-AI mode) and from your taps (advisor
   mode). It never sees anything you couldn't.
2. **Sampling consistent deals** (`src/ai/belief.ts`). It samples hundreds of complete deals consistent
   with everything observed: the opponent's current hand, the stock order, the identity of your
   face-down cards, and *the full history* — which card the opponent drew at each draw and which cards
   they gave at each give. Each sampled deal is then replayed from the real deal with the real
   sequence of actions, producing an exact game state.
3. **Inference from the opponent's choices.** During that replay every opponent decision is scored
   with an opponent model (softmax over a heuristic evaluation, mixed with 15% uniform so unusual
   players aren't ruled out). A deal's weight is the probability the opponent would have played what
   they actually played. If they gave cards instead of beating your 10, deals in which they could have
   beaten it cheaply become unlikely. Against the heuristic player this raises the probability given to
   the opponent's true cards from 0.17 to 0.21 on average.
4. **Information-Set Monte Carlo Tree Search** (`src/ai/ismcts.ts`). Each iteration picks a weighted
   deal and walks one tree whose nodes are *your* information sets: nodes are keyed by what you
   observe (the opponent's face-down gives only by count, your own draws by card). A move is judged by
   how it does across all the deals you can't tell apart, not by peeking at one of them. Leaves are
   valued by an exact alpha-beta solver of the rest of the hand in that deal (`src/ai/solver.ts`,
   about 0.3 ms per hand thanks to 0/1 values and a transposition table). The opponent's own ვარ
   decisions inside the search use only *their* information (they can't see what you gave them).

**ვარ decisions** come from the same weighted deals: claiming is worth exactly P(your pile ≥ 31), and
the search compares that with the value of playing on.

**Stakes** (`src/ai/stake.ts`) are decided from the searched win chance *p*. Accepting a raise at stake
*s* is correct when *p* > 1/(2(*s*+1)) — declining loses *s* for sure, accepting risks *s*+1 — plus a
margin because the raise itself signals strength. The AI proposes a raise when *p* ≥ 0.7.

## How strong is it?

Duplicate self-play: every deal is played twice with seats swapped, which cancels most card luck.
Stake cap 1 (pure card play and claims), 2000 search iterations per move.

| Match-up | Hands | Win rate of first | Points / hand |
|---|---:|---:|---:|
| ISMCTS + solver vs heuristic player | 3000 | **58.6%** | +0.172 ± 0.028 |
| ISMCTS + heuristic playouts vs heuristic player | 3000 | 58.4% | +0.167 ± 0.026 |
| ISMCTS + solver vs ISMCTS + playouts | 3000 | 50.0% | +0.001 ± 0.023 |
| ISMCTS vs PIMC (determinize + solve, no tree) | 3000 | 50.0% | −0.001 ± 0.024 |
| *Cheater that sees every card* vs heuristic | 300 | 72.7% | — |
| Heuristic vs random | 400 | 93.5% | — |

What this shows:

- The search clearly beats a sensible rule-of-thumb player. Its ვარ calls are almost always right,
  while the heuristic claims wrongly 17% of the time.
- Very different search methods (tree vs no tree, exact solver vs playouts) and 7× more iterations
  (15 000 vs 2 000) all land at the same strength. That points to the limit set by the hidden cards,
  not by the algorithm. The only thing that beats it by a lot is seeing the opponent's cards (the
  cheater row).
- Letting the search peek at its own face-down cards for ვარ decisions gave no measurable gain, so the claim logic is close to ideal.

## Layout

| Path | Purpose |
|---|---|
| `src/core/cards.ts` | Cards as ints 0..19, card sets as 20-bit masks |
| `src/core/rules.ts` | Rule options, beating, legal leads/beats/gives |
| `src/core/state.ts` | Full game state and actions (engine and simulations) |
| `src/core/view.ts` | Observations, a player's information set, `HandRunner` |
| `src/ai/belief.ts` | Sampling hidden cards and history, opponent-model weights |
| `src/ai/ismcts.ts` | The search |
| `src/ai/solver.ts` | Exact solver for fully known positions |
| `src/ai/heuristic.ts` | Rule-of-thumb evaluation, playout policy, claim probability |
| `src/ai/stake.ts` | Raise / accept policy |
| `src/ai/advisor.ts` | `analyze(view)` → recommendation with evidence |
| `src/ai/bots.ts`, `src/ai/match.ts` | Bots and duplicate matches |
| `src/cli/bench.ts` | Self-play benchmark |
| `src/web/*` | UI (plain TypeScript, the AI runs in a Web Worker) |
| `test/*` | Vitest suite |

## Fairness

Deals use the platform's cryptographic random generator (`crypto.getRandomValues`) with a
Fisher–Yates shuffle. The AI only receives its own observations; a test asserts face-down cards never
reach the player who receives them.

## History

This is a TypeScript rebuild of an earlier C#/.NET prototype, based on its handoff notes. It keeps the
same rules and adds the advisor for real games, history-aware inference, and the exact solver.
