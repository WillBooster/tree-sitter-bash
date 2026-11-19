import { expect, test } from 'vitest';

import { isWasmStale, parse } from '../helpers/differential/compare.js';

// Only `bun run build/ci` rebuilds the Wasm build, so a check against a stale one would pass after a source edit that
// brings the slowdown back.
test('uses a Wasm build of the current parser', () => {
  expect(isWasmStale(), 'generation inputs or src/ changed after the Wasm build; run `bun run build/ci`').toBe(false);
});

test.each([
  [
    'nested arithmetic substitutions',
    (words: number) => {
      const depth = words / 125;
      return `printf "%s\\n" "${'$((1+'.repeat(depth)}1${'))'.repeat(depth)}"\n`.repeat(30);
    },
  ],
  ['unfinished arithmetic openers', (words: number) => 'echo $((1+\n'.repeat(words / 4) + '1\n', true],
  ['words that concatenate with strings', (words: number) => `echo ${'a"b"; '.repeat(words)}\n`],
  ['a line after a line continuation', (words: number) => `x \\\n${'a"b" '.repeat(words)}\n`],
  ['open heredoc bodies with expansions', (words: number) => `cat <<EOF\n${'$x '.repeat(words)}\nEOF\n`],
])('parses large %s inputs with proportional growth', { timeout: 60_000 }, (_, script, expectedError = false) => {
  const small = script(4000);
  const large = script(40_000);
  parseCpuTime(large, expectedError);
  parseCpuTime(large, expectedError);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small, expectedError));
    largeFastest = Math.min(largeFastest, parseCpuTime(large, expectedError));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
});

function parseCpuTime(script: string, expectedError = false): number {
  const start = process.threadCpuUsage();
  let parses = 0;
  let elapsed = 0;
  let mismatches = 0;
  // Linux thread CPU accounting can advance in millisecond steps. Batch short parses so the fastest
  // sample cannot win by falling between accounting updates and distort the growth ratio.
  do {
    const tree = parse(script);
    if (tree.rootNode.hasError !== expectedError) mismatches++;
    tree.delete();
    parses++;
    const { system, user } = process.threadCpuUsage(start);
    elapsed = system + user;
  } while (elapsed < 50_000);
  expect(mismatches).toBe(0);
  return elapsed / parses;
}
