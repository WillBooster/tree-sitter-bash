import { test } from 'bun:test';

import { expectToSucceed } from './run.js';

const Timeout = 1_800_000;

// Clones real-world scripts into examples/ on the first run, which takes a few minutes.
test('fails to parse exactly the real-world scripts in script/known-failures.txt', () => {
  expectToSucceed(['script/parse-examples', '--check'], Timeout);
}, Timeout);
