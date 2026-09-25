import { test } from 'bun:test';

import { expectToSucceed } from './run.js';

test('parses the corpus in test/corpus as expected', () => {
  expectToSucceed(['bun', 'run', 'tree-sitter', 'test']);
}, 300_000);
