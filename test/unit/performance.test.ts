import { expect, test } from 'vitest';

import { isWasmStale, parse } from '../helpers/differential/compare.js';

// Only `bun run build/ci` rebuilds the Wasm build, so a check against a stale one would pass after a source edit that
// brings the slowdown back.
test('uses a Wasm build of the current parser', () => {
  expect(isWasmStale(), 'grammar.js or src/ changed after the Wasm build; run `bun run build/ci`').toBe(false);
});

// Consumers parse untrusted scripts, so a long line must not make parsing superlinear: ten times the words take about
// ten times as long, against a hundred times for a quadratic scanner. The ratio, unlike an absolute limit, holds on
// slow CI runners. The parses are timed in the CPU time of this test file's process (see `pool` in vitest.config.mts),
// not in wall-clock time, which other processes inflate unevenly. Each size keeps its fastest run to filter out the
// remaining noise, such as garbage collection.
test.each([
  ['words that concatenate with strings', (words: number) => `echo ${'a"b"; '.repeat(words)}\n`],
  ['a line after a line continuation', (words: number) => `x \\\n${'a"b" '.repeat(words)}\n`],
])('parses a long line of %s in linear time', { timeout: 60_000 }, (_, script) => {
  expect(fastestParseCpuTime(script(40_000)) / fastestParseCpuTime(script(4000))).toBeLessThan(30);
});

function fastestParseCpuTime(script: string): number {
  let fastest = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = process.cpuUsage();
    const tree = parse(script);
    const { system, user } = process.cpuUsage(start);
    fastest = Math.min(fastest, system + user);
    const { hasError } = tree.rootNode;
    tree.delete();
    expect(hasError).toBe(false);
  }
  return fastest;
}
