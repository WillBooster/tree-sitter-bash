import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { testCommand } from './run.js';

// Edits each corpus case at random and reparses it incrementally, then undoes the edits and reparses
// again: the changed ranges must cover every change and the final tree must match the corpus. The CLI
// exits zero even when a case fails or no corpus is found, so its output decides: it must list the cases
// it fuzzed and print no failure summary. TREE_SITTER_SEED, TREE_SITTER_ITERATIONS,
// and TREE_SITTER_EDITS explore further locally.
testCommand('reparses the corpus consistently after random edits', ['bun', 'run', 'tree-sitter', 'fuzz'], 900_000, {
  env: {
    TREE_SITTER_SEED: process.env.TREE_SITTER_SEED ?? '1',
    TREE_SITTER_ITERATIONS: process.env.TREE_SITTER_ITERATIONS ?? '1000',
    TREE_SITTER_EDITS: process.env.TREE_SITTER_EDITS ?? '10',
  },
  check: (output) => {
    expect(output).toMatch(/^ +\d+\. .+ - corpus - /m);
    expect(output).not.toContain('failed fuzzing');
  },
});

// Edits that the random ones reach only rarely. Each inserts `text` at `position` of `before`.
const edits = [
  {
    name: 'a newline after a special parameter in a heredoc body makes the next line its delimiter',
    before: 'cat <<EOF\n$1EOF\n$y\nEOF\n',
    position: 12,
    text: '\n',
  },
  ...['a;', 'a&', 'f a;', 'a=1;'].map((statements) => {
    const before = `c i1 $(cat <<'EOF'; cat <<END\nEOF) ${statements}\\\n`;
    return {
      name: `a deferred body after \`${statements}\` and a backslash-newline is appended`,
      before,
      position: before.length,
      text: 'e1\nEND\nc i1b\n',
    };
  }),
];

for (const { name, before, position, text } of edits) {
  test(`reparses as a fresh parse after an edit: ${name}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-sitter-bash-'));
    try {
      const beforePath = path.join(dir, 'before.sh');
      const afterPath = path.join(dir, 'after.sh');
      fs.writeFileSync(beforePath, before);
      fs.writeFileSync(afterPath, before.slice(0, position) + text + before.slice(position));
      const incremental = parseWithCli([beforePath, '--edits', `${position} 0 ${text}`]);
      expect(incremental).not.toContain('ERROR');
      expect(incremental).toBe(parseWithCli([afterPath]));
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }, 120_000);
}

function parseWithCli(args: string[]): string {
  const result = spawnSync('bun', ['run', 'tree-sitter', 'parse', ...args], {
    cwd: path.join(import.meta.dirname, '../..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
