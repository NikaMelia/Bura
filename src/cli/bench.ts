/*
 * Duplicate self-play benchmark.
 *   npm run bench -- --a ismcts --b heuristic --deals 200 --iters 2000 [--raises] [--seed 1]
 * Bots: random, heuristic, flat, ismcts-noinf, ismcts.
 * Without --raises the stake cap is 1, which measures pure card play and claiming.
 */
import { makeBot } from '../ai/bots';
import { duplicateMatch } from '../ai/match';
import { DEFAULT_RULES } from '../core/rules';
import { seededRng } from '../core/rng';
import { shuffledDeck } from '../core/state';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const a = arg('a', 'ismcts');
const b = arg('b', 'heuristic');
const dealsN = Number(arg('deals', '100'));
const iters = Number(arg('iters', '2000'));
const itersB = Number(arg('iters-b', String(iters)));
const seed = Number(arg('seed', '1'));
const extraA = JSON.parse(arg('a-opts', '{}'));
const extraB = JSON.parse(arg('b-opts', '{}'));
const rules = { ...DEFAULT_RULES, maxStake: flag('raises') ? DEFAULT_RULES.maxStake : 1 };

const rng = seededRng(seed);
const deals = Array.from({ length: dealsN }, () => shuffledDeck(rng));
let botSeed = seed * 1000;
const t0 = Date.now();
console.log(`${a} ${JSON.stringify(extraA)} (${iters} it) vs ${b} ${JSON.stringify(extraB)} (${itersB} it), ${dealsN} deals x2 seats, raises ${flag('raises') ? 'on' : 'off'}`);
const res = duplicateMatch(
  () => makeBot(a, { iterations: iters, seed: botSeed++, extra: extraA }),
  () => makeBot(b, { iterations: itersB, seed: botSeed++, extra: extraB }),
  deals,
  rules,
  (done, s) => {
    if (done % 10 === 0 || done === dealsN) {
      process.stdout.write(
        `  ${done}/${dealsN}  ${a} win rate ${(100 * s.aHandWinRate).toFixed(1)}%  ` +
          `points/hand ${s.aPointsPerHand >= 0 ? '+' : ''}${s.aPointsPerHand.toFixed(3)} ± ${s.ci95.toFixed(3)}  ` +
          `(${((Date.now() - t0) / 1000).toFixed(0)}s)\n`,
      );
    }
  },
);
console.log('end reasons:', res.reasons);
