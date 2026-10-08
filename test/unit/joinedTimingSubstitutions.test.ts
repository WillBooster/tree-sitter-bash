import path from 'node:path';

import { Edit, Language, Parser, Query, type Node } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-bash.wasm'));
const snapshot = (node: Node, ranges = true): unknown => [
  node.type,
  node.grammarType,
  node.isNamed,
  node.isExtra,
  node.isMissing,
  node.isError,
  node.hasError,
  ...(ranges ? [node.startIndex, node.endIndex, node.startPosition, node.endPosition] : []),
  node.children.map((_, i) => node.fieldNameForChild(i)),
  node.children.length > 0 ? node.children.map((child) => snapshot(child, ranges)) : node.text.replaceAll('\\\n', ''),
];
const point = (source: string, index: number): { row: number; column: number } => {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
};

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
          expect(snapshot(tree.rootNode, false), source).toEqual(snapshot(reference.rootNode, false));
          const captures = query.captures(tree.rootNode);
          expect(
            captures.filter(({ name }) => name === 'assignment'),
            source
          ).toHaveLength(1);
          const timed = captures.find(({ name }) => name === 'timed')!.node;
          expect(timed.startIndex, source).toBe(source.indexOf(keyword));
          expect(timed.endIndex, source).toBe(source.indexOf('esac') + 4);
          let current = source;
          let previous = tree.copy();
          try {
            for (const next of [canonical, source]) {
              let start = 0;
              while (start < current.length && start < next.length && current[start] === next[start]) start++;
              previous.edit(
                new Edit({
                  startIndex: start,
                  oldEndIndex: current.length,
                  newEndIndex: next.length,
                  startPosition: point(current, start),
                  oldEndPosition: point(current, current.length),
                  newEndPosition: point(next, next.length),
                })
              );
              const edited = parser.parse(next, previous)!;
              const fresh = parser.parse(next)!;
              try {
                expect(snapshot(edited.rootNode), next).toEqual(snapshot(fresh.rootNode));
              } finally {
                fresh.delete();
                previous.delete();
              }
              previous = edited;
              current = next;
            }
          } finally {
            previous.delete();
          }
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
