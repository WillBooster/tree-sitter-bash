import path from 'node:path';

import { Language, type Node, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-bash.wasm'));
const snapshot = (node: Node): unknown => [
  node.type,
  node.grammarType,
  node.isNamed,
  node.isExtra,
  node.isMissing,
  node.isError,
  node.hasError,
  node.children.map((_, i) => node.fieldNameForChild(i)),
  node.children.length > 0 ? node.children.map((child) => snapshot(child)) : node.text.replaceAll('\\\n', ''),
];

test('keeps joined timing options in arithmetic-looking command substitutions', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(
    language,
    '(variable_assignment value: (command_substitution (subshell))) @assignment (timed_command) @timed'
  );
  try {
    for (const keyword of ['time', 'ti\\\nme']) {
      for (const options of ['-\\\np', '-\\\n-', '-\\\np --', '-p -\\\n-', '-\\\np -\\\n-', '-\\\n\\\np -\\\n\\\n-']) {
        const source = `emit(){ :; }; seed(){ printf C; }\nv=$(( $(${keyword} ${options} case x in x) emit;; esac # '\nprintf seed\n) + 1 ))\nprintf '%s\\n' "$v"\n`;
        const canonical = source.replaceAll('\\\n', '');
        const tree = parser.parse(source)!;
        const reference = parser.parse(canonical)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(reference.rootNode.hasError, canonical).toBe(false);
          expect(snapshot(tree.rootNode), source).toEqual(snapshot(reference.rootNode));
          const captures = query.captures(tree.rootNode);
          expect(
            captures.filter(({ name }) => name === 'assignment'),
            source
          ).toHaveLength(1);
          const timed = captures.find(({ name }) => name === 'timed')!.node;
          expect(timed.startIndex, source).toBe(source.indexOf(keyword));
          expect(timed.endIndex, source).toBe(source.indexOf('esac') + 4);
        } finally {
          reference.delete();
          tree.delete();
        }
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});
