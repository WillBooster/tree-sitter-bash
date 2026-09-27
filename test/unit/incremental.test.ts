import { expect, test } from 'bun:test';

import { expectToSucceed } from './run.js';

const Timeout = 900_000;

// Edits each corpus case at random and reparses it incrementally, then undoes the edits and reparses
// again: the changed ranges must cover every change and the final tree must match the corpus. The CLI
// exits zero even when a case fails, so its summary decides. TREE_SITTER_SEED, TREE_SITTER_ITERATIONS,
// and TREE_SITTER_EDITS explore further locally.
test('reparses the corpus consistently after random edits', () => {
  const output = expectToSucceed(['bun', 'run', 'tree-sitter', 'fuzz'], Timeout, {
    TREE_SITTER_SEED: '1',
    TREE_SITTER_ITERATIONS: '1000',
    TREE_SITTER_EDITS: '10',
  });
  expect(output).not.toContain('failed fuzzing');
}, Timeout);
