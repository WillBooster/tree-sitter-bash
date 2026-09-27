import { expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { testCommand } from './run.js';

const CorpusDir = path.join(import.meta.dir, '../corpus');
// Each case opens with a name between two lines of `=`.
const CaseCount =
  fs
    .readdirSync(CorpusDir)
    .flatMap((name) => fs.readFileSync(path.join(CorpusDir, name), 'utf8').split('\n'))
    .filter((line) => /^=+$/.test(line)).length / 2;

// Edits each corpus case at random and reparses it incrementally, then undoes the edits and reparses
// again: the changed ranges must cover every change and the final tree must match the corpus. The CLI
// exits zero even when a case fails or no corpus is found, so its output decides: it must list every case
// and print no failure summary. TREE_SITTER_SEED, TREE_SITTER_ITERATIONS, and TREE_SITTER_EDITS explore
// further locally.
testCommand('reparses the corpus consistently after random edits', ['bun', 'run', 'tree-sitter', 'fuzz'], 900_000, {
  env: {
    TREE_SITTER_SEED: process.env.TREE_SITTER_SEED ?? '1',
    TREE_SITTER_ITERATIONS: process.env.TREE_SITTER_ITERATIONS ?? '1000',
    TREE_SITTER_EDITS: process.env.TREE_SITTER_EDITS ?? '10',
  },
  check: (output) => {
    expect(CaseCount).toBeGreaterThan(0);
    expect(output.match(/^ +\d+\. .+ - corpus - /gm)?.length ?? 0).toBe(CaseCount);
    expect(output).not.toContain('failed fuzzing');
  },
});
