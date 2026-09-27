import { test } from 'bun:test';

import { expectToSucceed } from './run.js';

const Timeout = 300_000;

test('parses the corpus in test/corpus as expected', () => {
  expectToSucceed(['bun', 'run', 'tree-sitter', 'test'], Timeout);
}, Timeout);
