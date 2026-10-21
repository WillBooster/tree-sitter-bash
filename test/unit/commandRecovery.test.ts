import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

test('preserves commands in a malformed for loop', async () => {
  const source = 'for i in a; do\necho\n;;\nesac\ndone\n';
  const expected =
    '(program (for_statement variable: (variable_name) value: (word) body: (do_group (command name: (command_name (word))) (ERROR) (command name: (command_name (word))))))';
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(path.join(import.meta.dirname, '../../tree-sitter-bash.wasm')));
  try {
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.toString()).toBe(expected);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});
