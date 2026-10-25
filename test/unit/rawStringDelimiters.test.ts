import path from 'node:path';

import { Edit, Language, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import { beforeAll, expect, test } from 'vitest';

let language: Language;
beforeAll(async () => {
  await Parser.init();
  language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-bash.wasm'));
});

test('queries both delimiters of literal strings without interpreting their contents', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, `(raw_string . "'" @open "'" @close .)`);
  const sources = [
    "printf '%s\\n' '' ' ' 'literal\\' 'line\nbreak' 'it'\\''s'\n",
    "value='a'$x'b'\nprintf '%s\\n' \"$(printf '%s' '$(literal)')\"\n",
    "printf '%s' \"`printf '%s' 'literal'`\"\n",
  ];
  try {
    for (const [sourceIndex, source] of sources.entries()) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const strings = tree.rootNode.descendantsOfType('raw_string');
        expect(strings.length, source).toBe([7, 5, 3][sourceIndex]);
        const matches = query.matches(tree.rootNode);
        expect(matches.length, source).toBe(strings.length);
        for (const [index, node] of strings.entries()) {
          expect(
            matches[index]!.captures.map(({ name, node: delimiter }) => [
              name,
              delimiter.text,
              delimiter.startIndex,
              delimiter.endIndex,
            ])
          ).toEqual([
            ['open', "'", node.startIndex, node.startIndex + 1],
            ['close', "'", node.endIndex - 1, node.endIndex],
          ]);
        }
      } finally {
        tree.delete();
      }
    }
    const source = 'echo "$(cat <<EOF\nEOF)" \'a\\\nb\'\n';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const node = tree.rootNode.descendantsOfType('raw_string')[0]!;
      expect(
        query
          .captures(tree.rootNode)
          .map(({ name, node: delimiter }) => [name, delimiter.startIndex, delimiter.endIndex])
      ).toEqual([
        ['open', node.startIndex, node.startIndex + 1],
        ['close', node.endIndex - 1, node.endIndex],
      ]);
      expect(node.namedChildren.map((child) => child.text)).toEqual(['a', 'b']);
    } finally {
      tree.delete();
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('keeps newlines inside literal arguments before pending heredoc bodies', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const content of ['\nliteral', ' \nliteral']) {
      const source = `cat <<EOF '${content}'\nbody\nEOF\n`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('raw_string').map((node) => node.text)).toEqual([`'${content}'`]);
        expect(tree.rootNode.descendantsOfType('heredoc_content').map((node) => node.text)).toEqual(['\nbody\n']);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('updates quote-pair query ranges after incremental edits and undo', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, `(raw_string . "'" @open "'" @close .)`);
  const source = "printf '%s' 'ab' 'cd'\n";
  const index = source.indexOf('ab') + 1;
  const text = "'x'";
  const changed = source.slice(0, index) + text + source.slice(index);
  const before = parser.parse(source)!;
  before.edit(
    new Edit({
      startIndex: index,
      oldEndIndex: index,
      newEndIndex: index + text.length,
      startPosition: { row: 0, column: index },
      oldEndPosition: { row: 0, column: index },
      newEndPosition: { row: 0, column: index + text.length },
    })
  );
  const incremental = parser.parse(changed, before)!;
  const fresh = parser.parse(changed)!;
  try {
    expect(incremental.rootNode.hasError).toBe(false);
    expect(captureRanges(query, incremental)).toHaveLength(8);
    expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
    expect(captureRanges(query, incremental)).toEqual(captureRanges(query, fresh));
    incremental.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index + text.length,
        newEndIndex: index,
        startPosition: { row: 0, column: index },
        oldEndPosition: { row: 0, column: index + text.length },
        newEndPosition: { row: 0, column: index },
      })
    );
    const undone = parser.parse(source, incremental)!;
    const original = parser.parse(source)!;
    try {
      expect(undone.rootNode.toString()).toBe(original.rootNode.toString());
      expect(captureRanges(query, undone)).toEqual(captureRanges(query, original));
    } finally {
      undone.delete();
      original.delete();
    }
  } finally {
    before.delete();
    incremental.delete();
    fresh.delete();
    query.delete();
    parser.delete();
  }
});

function captureRanges(query: Query, tree: Tree): [string, number, number][] {
  return query
    .matches(tree.rootNode)
    .flatMap(({ captures }) =>
      captures.map(({ name, node }): [string, number, number] => [name, node.startIndex, node.endIndex])
    );
}
