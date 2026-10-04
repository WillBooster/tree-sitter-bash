import { expect, test } from 'vitest';

import { isWasmStale, parse } from '../helpers/differential/compare.js';

// Only `bun run build/ci` rebuilds the Wasm build, so a check against a stale one would pass after a source edit that
// brings the slowdown back.
test('uses a Wasm build of the current parser', () => {
  expect(isWasmStale(), 'grammar.js or src/ changed after the Wasm build; run `bun run build/ci`').toBe(false);
});

// These concatenation, line-continuation and plain nested-arithmetic shapes should grow proportionally: ten times the
// input takes about ten times as long, against a hundred times for a quadratic scanner. The ratio holds on
// slow CI runners. The parses are timed in the CPU time of the thread that runs them: wall-clock time is inflated
// unevenly by other processes, and the process's CPU time also counts the engine's background threads, which compile
// the Wasm build and collect garbage during the parses. The small and large scripts are measured after warm-up parses and
// in alternation, each keeping its fastest run; their ratio is 10 to 12 locally, and 18 leaves a margin over that
// while failing for growth faster than about n^1.25.
test.each([
  [
    'nested arithmetic substitutions',
    (words: number) => {
      const depth = words / 125;
      return `printf "%s\\n" "${'$((1+'.repeat(depth)}1${'))'.repeat(depth)}"\n`.repeat(30);
    },
  ],
  ['words that concatenate with strings', (words: number) => `echo ${'a"b"; '.repeat(words)}\n`],
  ['a line after a line continuation', (words: number) => `x \\\n${'a"b" '.repeat(words)}\n`],
])('parses a long line of %s in linear time', { timeout: 60_000 }, (_, script) => {
  const small = script(4000);
  const large = script(40_000);
  parseCpuTime(large);
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
});

function parseCpuTime(script: string): number {
  const start = process.threadCpuUsage();
  const tree = parse(script);
  const { system, user } = process.threadCpuUsage(start);
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(false);
  return system + user;
}
