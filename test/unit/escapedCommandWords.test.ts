import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

test('keeps arithmetic expansions when command words precede case arguments', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-bash.wasm'));
  try {
    for (const command of [
      String.raw`\:`,
      String.raw`\x`,
      String.raw`\;`,
      "$'a'",
      "$':'",
      'printf x{',
      'printf {',
      '{x',
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

test('counts parentheses in assignment subscripts when selecting outer arithmetic', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-bash.wasm'));
  try {
    for (const tail of ['; echo 3', '# c\necho 3']) {
      for (const [key, type] of [
        ['(', 'command_substitution'],
        [')', 'command_substitution'],
        ['(x)', 'arithmetic_expansion'],
        ['((x))', 'arithmetic_expansion'],
      ]) {
        const source = `declare -A m; x=$(( $(m[${key}]=1 ${tail}) + 1 )); echo "[$x]"`;
        const tree = parser.parse(source)!;
        try {
          const outer = tree.rootNode.descendantForIndex(source.indexOf('$(('), source.lastIndexOf('))') + 2)!;
          expect(outer.type, source).toBe(type);
          expect(outer.text).toBe(source.slice(source.indexOf('$(('), source.lastIndexOf('))') + 2));
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('tracks case bodies after function headers and assignment separators', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-bash.wasm'));
  try {
    for (const body of [
      'f() { case x in x) :;; esac; }',
      'function f { case x in x) :;; esac; }',
      'function f() { case x in x) :;; esac; }',
      'f() ( case x in x) :;; esac )',
      ...['\n', ';', ' ;', '&', '|'].map((separator) => `q=0${separator}case x in x) :;; esac`),
      '>f\ncase x in x) :;; esac',
    ]) {
      const source = `v=$(( $(: <<E\na # (\nE\n${body} # \`\nprintf 1\n) + 1 ))\nprintf "%s\\n" "$v"\n`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const outer = tree.rootNode.descendantsOfType('arithmetic_expansion')[0]!;
        expect(outer.startIndex).toBe(2);
        expect(outer.endIndex).toBe(source.indexOf('))\nprintf') + 2);
        const index = source.indexOf('printf 1') + 7;
        const prefix = source.slice(0, index).split('\n');
        const point = { row: prefix.length - 1, column: prefix.at(-1)!.length };
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index + 1,
            newEndIndex: index + 1,
            startPosition: point,
            oldEndPosition: { ...point, column: point.column + 1 },
            newEndPosition: { ...point, column: point.column + 1 },
          })
        );
        const changed = source.slice(0, index) + '2' + source.slice(index + 1);
        const incremental = parser.parse(changed, tree)!;
        const fresh = parser.parse(changed)!;
        try {
          expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
          expect(incremental.rootNode.descendantsOfType('arithmetic_expansion')[0]?.text).toContain('printf 2');
        } finally {
          incremental.delete();
          fresh.delete();
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
