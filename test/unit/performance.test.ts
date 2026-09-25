import { expect, test } from 'bun:test';

import { parse } from '../helpers/differential/compare.js';

// Consumers parse untrusted scripts, so a long line must not make parsing superlinear. Linear
// parsing takes about 0.1 s here; a quadratic scanner took over 20 s.
test.each([
  ['words that concatenate with strings', `echo ${Array.from({ length: 40_000 }, () => 'a"b";').join(' ')}\n`],
  ['a line after a line continuation', `x \\\n${Array.from({ length: 40_000 }, () => 'a"b"').join(' ')}\n`],
])('parses a 240 KB line of %s in linear time', (_, script) => {
  const start = performance.now();
  expect(parse(script).rootNode.hasError).toBe(false);
  expect(performance.now() - start).toBeLessThan(3000);
});
