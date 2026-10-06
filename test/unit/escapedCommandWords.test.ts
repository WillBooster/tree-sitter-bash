import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

test('keeps arithmetic expansions when escaped command words precede case arguments', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-bash.wasm'));
  try {
    for (const command of [
      String.raw`\:`,
      String.raw`\x`,
      String.raw`\;`,
      "$'a'",
      'x=1',
      'x+=1',
      'x=',
      'x="1"',
      'x=$y',
      '2>f',
      '2>f x=1',
    ]) {
      const source = `x=$(( $(${command} case; echo in; echo 1) + 1 ))`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('arithmetic_expansion').map((node) => node.text)).toEqual([
          source.slice(2),
        ]);
        expect(tree.rootNode.descendantsOfType('case_statement')).toHaveLength(0);
        const index = source.indexOf('echo 1') + 5;
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index + 1,
            newEndIndex: index + 1,
            startPosition: { row: 0, column: index },
            oldEndPosition: { row: 0, column: index + 1 },
            newEndPosition: { row: 0, column: index + 1 },
          })
        );
        const changed = source.slice(0, index) + '2' + source.slice(index + 1);
        const incremental = parser.parse(changed, tree)!;
        const fresh = parser.parse(changed)!;
        try {
          expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
          expect(incremental.rootNode.descendantsOfType('arithmetic_expansion')[0]?.text).toBe(changed.slice(2));
        } finally {
          incremental.delete();
          fresh.delete();
        }
      } finally {
        tree.delete();
      }
    }
    const source = 'x=$(( $(\\\necho 1) + 1 ))';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('arithmetic_expansion')).toHaveLength(1);
      expect(tree.rootNode.descendantsOfType('command_substitution')[0]?.text).toContain('echo 1');
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});
