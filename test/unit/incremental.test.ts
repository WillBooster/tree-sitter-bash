import { expect } from 'bun:test';

import { testCommand } from './run.js';

// Edits each corpus case at random and reparses it incrementally, then undoes the edits and reparses
// again: the changed ranges must cover every change and the final tree must match the corpus. The CLI
// exits zero even when a case fails or no corpus is found, so its output decides: it must list the cases
// it fuzzed and report neither an error nor a failure summary. TREE_SITTER_SEED, TREE_SITTER_ITERATIONS,
// and TREE_SITTER_EDITS explore further locally.
testCommand('reparses the corpus consistently after random edits', ['bun', 'run', 'tree-sitter', 'fuzz'], 900_000, {
  env: {
    TREE_SITTER_SEED: process.env.TREE_SITTER_SEED ?? '1',
    TREE_SITTER_ITERATIONS: process.env.TREE_SITTER_ITERATIONS ?? '1000',
    TREE_SITTER_EDITS: process.env.TREE_SITTER_EDITS ?? '10',
  },
  check: (output) => {
    expect(output).toMatch(/^ +\d+\. .+ - corpus - /m);
    expect(output).not.toContain('Error:');
    expect(output).not.toContain('failed fuzzing');
  },
});
