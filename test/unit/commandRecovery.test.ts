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

test.each(['>', '<', '>>', '>|', '<>', '&>', '&>>', '<&', '>&', '2>', '3<>', '<<<', '4<<<'])(
  'preserves the next command after a missing %s destination',
  async (operator) => {
    const parser = await createParser();
    const source = `echo ${operator}\nprintf FOLLOWING\n`;
    try {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError).toBe(true);
        expect(tree.rootNode.descendantsOfType('command').map((node) => node.text)).toContain('printf FOLLOWING');
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  }
);

test.each([
  '> \t\n',
  '> # no destination\n',
  '>\\\n\n',
  '<path>\n',
  '>;\n',
  '>&;\n',
  '<<<;\n',
  '> )\n',
  '> &\n',
  '> | cat\n',
  '> (\n',
  '> <file\n',
  '> >file\n',
])('keeps a missing destination before %j separate from the next command', async (redirect) => {
  const parser = await createParser();
  try {
    const tree = parser.parse(`echo ${redirect}printf FOLLOWING\n`)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      expect(tree.rootNode.descendantsOfType('command').map((node) => node.text)).toContain('printf FOLLOWING');
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test.each([
  'echo "$(echo >\nprintf FOLLOWING\n)"\n',
  'echo `echo >\nprintf FOLLOWING\n`\n',
  'f() { echo >\nprintf FOLLOWING\n}\n',
  'echo >\nprintf FOLLOWING | cat\n',
])('preserves command boundaries around a malformed redirect in %j', async (source) => {
  const parser = await createParser();
  try {
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      expect(tree.rootNode.descendantsOfType('command').map((node) => node.text)).toContain('printf FOLLOWING');
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test.each([
  'echo >file\nprintf FOLLOWING\n',
  'echo 2> file\nprintf FOLLOWING\n',
  'echo >\\\nfile\nprintf FOLLOWING\n',
  'echo > \\\n \t\\\nfile\nprintf FOLLOWING\n',
  'echo >"multi\nline"\nprintf FOLLOWING\n',
  "echo >'multi\nline'\nprintf FOLLOWING\n",
  'echo >\\#file\nprintf FOLLOWING\n',
  'echo >$(printf file)\nprintf FOLLOWING\n',
  'echo >&-\nprintf FOLLOWING\n',
  'echo <<<\\\ninput\nprintf FOLLOWING\n',
  'cat <<EOF >file\nbody\nEOF\nprintf FOLLOWING\n',
  'echo > <(printf file)\nprintf FOLLOWING\n',
  'echo > >(printf file)\nprintf FOLLOWING\n',
  'echo > \\\n<(printf file)\nprintf FOLLOWING\n',
  'echo > \\\n\\\n>(printf file)\nprintf FOLLOWING\n',
  'echo <<< <(printf file)\nprintf FOLLOWING\n',
  "echo >';'\nprintf FOLLOWING\n",
  'echo >\\;\nprintf FOLLOWING\n',
  'echo >"&"\nprintf FOLLOWING\n',
])('keeps valid redirect boundaries in %j', async (source) => {
  const parser = await createParser();
  try {
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('printf FOLLOWING');
      for (const redirect of tree.rootNode.descendantsOfType(['file_redirect', 'herestring_redirect'])) {
        const destination = redirect.childForFieldName('destination') ?? redirect.childForFieldName('value');
        if (!destination) continue;
        const byteLookup = tree.rootNode.namedDescendantForIndex(destination.startIndex);
        const pointLookup = tree.rootNode.namedDescendantForPosition(destination.startPosition);
        expect(byteLookup?.equals(destination)).toBe(true);
        expect(pointLookup?.equals(destination)).toBe(true);
      }
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

async function createParser(): Promise<Parser> {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(path.join(import.meta.dirname, '../../tree-sitter-bash.wasm')));
  return parser;
}
