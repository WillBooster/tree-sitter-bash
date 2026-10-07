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
      '[',
      'printf {',
      '{x',
      'x=1',
      'x+=1',
      'x=',
      '@()',
      '?()',
      '*()',
      '+()',
      'x=()',
      'x+=()',
      'x=(1)',
      'x[0]=()',
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
        ['a[(]', 'command_substitution'],
        ['a[)]', 'command_substitution'],
        ['a[(x)]', 'arithmetic_expansion'],
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
      ...[
        'f \\\n ()',
        'f(\\\n)',
        'foo-bar()',
        'foo.bar()',
        '1()',
        String.raw`f\ o()`,
        'function foo-bar',
        'a-b=()',
        'a[0]()',
        'a[0]b=()',
        String.raw`a\=()`,
        'function a=',
        'foo@(x)()',
        'foo@()()',
        'foo@(x|+(y))()',
        'function foo@(x)',
      ].map((header) => `${header} { case x in x) :;; esac; }`),
      'function f { case x in x) :;; esac; }',
      'function f() { case x in x) :;; esac; }',
      'f() ( case x in x) :;; esac )',
      'function f ( case x in x) :;; esac )',
      ': [[\ncase x in x) :;; esac',
      String.raw`coproc \a case $( :) in x) :;; esac`,
      String.raw`coproc a\b case $( :) in x) :;; esac`,
      'echo [[ x\ncase x in x) :;; esac',
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

test('preserves arithmetic selection around case commands in process substitutions', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-bash.wasm'));
  try {
    const source =
      'v=$(( $(: <<E\na # (\nE\ncat <(case x in x) :;; esac) # `\nprintf 1\n) + 1 )); printf "%s\\n" "$v"\n';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('arithmetic_expansion').map((node) => node.text)).toEqual([
        source.slice(2, source.indexOf('; printf')),
      ]);
      expect(tree.rootNode.descendantsOfType('case_statement')).toHaveLength(1);
      const index = source.indexOf('case x') + 5;
      const column = index - source.lastIndexOf('\n', index) - 1;
      tree.edit(
        new Edit({
          startIndex: index,
          oldEndIndex: index + 1,
          newEndIndex: index + 1,
          startPosition: { row: 3, column },
          oldEndPosition: { row: 3, column: column + 1 },
          newEndPosition: { row: 3, column: column + 1 },
        })
      );
      const changed = source.slice(0, index) + 'y' + source.slice(index + 1);
      const incremental = parser.parse(changed, tree)!;
      const fresh = parser.parse(changed)!;
      try {
        expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(incremental.rootNode.hasError).toBe(false);
        expect(incremental.rootNode.descendantsOfType('arithmetic_expansion')).toHaveLength(1);
      } finally {
        incremental.delete();
        fresh.delete();
      }
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test('keeps command selection for out-of-range ANSI-C heredoc delimiters', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-bash.wasm'));
  try {
    for (const escape of ['80000000', 'ffffffff']) {
      const source = `emit_number() { printf 3; }\nvalue="$(( $(cat >/dev/null <<$'\\U${escape}'\na (\n\\U\nprintf emit_number\n) + 2 ))"\nprintf 'VALUE=[%s]\\n' "$value"\n`;
      const tree = parser.parse(source)!;
      try {
        const start = source.indexOf('$((');
        const end = source.indexOf('))"') + 2;
        expect(tree.rootNode.descendantsOfType('arithmetic_expansion')).toHaveLength(0);
        expect(tree.rootNode.descendantsOfType('command_substitution').map((node) => node.text)).toContain(
          source.slice(start, end)
        );
        const index = source.indexOf(escape);
        const changed = source.slice(0, index) + '80000001' + source.slice(index + escape.length);
        const column = index - source.lastIndexOf('\n', index) - 1;
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index + escape.length,
            newEndIndex: index + 8,
            startPosition: { row: 1, column },
            oldEndPosition: { row: 1, column: column + escape.length },
            newEndPosition: { row: 1, column: column + 8 },
          })
        );
        const edited = parser.parse(changed, tree)!;
        const fresh = parser.parse(changed)!;
        try {
          expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
          expect(edited.rootNode.descendantsOfType('arithmetic_expansion')).toHaveLength(0);
          expect(edited.rootNode.descendantsOfType('command_substitution').map((node) => node.text)).toContain(
            changed.slice(start, end)
          );
        } finally {
          edited.delete();
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

test('preserves case substitution recovery while closing an unfinished expansion', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-bash.wasm'));
  let source = 'x=$(( $(case a in a) :;; esac )\n';
  let tree = parser.parse(source)!;
  try {
    for (let closers = 1; closers <= 3; closers++) {
      const substitution = tree.rootNode.descendantsOfType('command_substitution')[0]!;
      expect(tree.rootNode.descendantsOfType('case_statement')).toHaveLength(1);
      if (closers < 3) expect(tree.rootNode.descendantsOfType('subshell')).toHaveLength(0);
      if (closers === 1) {
        const name = substitution.parent!;
        expect(name.type).toBe('command_name');
        expect(name.parent!.childForFieldName('name')!.id).toBe(name.id);
        expect(tree.rootNode.descendantsOfType('ERROR')[0]!.endIndex).toBe(source.length);
      } else if (closers === 2) {
        expect(substitution.parent!.type).toBe('ERROR');
        expect(substitution.parent!.endIndex).toBe(source.length - 1);
      } else {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.descendantsOfType('subshell')).toHaveLength(1);
        break;
      }
      const index = source.length - 1;
      tree.edit(
        new Edit({
          startIndex: index,
          oldEndIndex: index,
          newEndIndex: index + 1,
          startPosition: { row: 0, column: index },
          oldEndPosition: { row: 0, column: index },
          newEndPosition: { row: 0, column: index + 1 },
        })
      );
      source = source.slice(0, index) + ')\n';
      const edited = parser.parse(source, tree)!;
      const fresh = parser.parse(source)!;
      try {
        expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
      } finally {
        fresh.delete();
      }
      tree.delete();
      tree = edited;
    }
    for (const suffix of [' \\\n', '\n\\\n', ' \\\n \\\n']) {
      const continuedSource = 'x=$(( $(case a in a) :;; esac ))' + suffix;
      const continued = parser.parse(continuedSource)!;
      try {
        expect(continued.rootNode.descendantsOfType('subshell')).toHaveLength(0);
        expect(continued.rootNode.descendantsOfType('command_substitution')[0]!.parent!.type).toBe('ERROR');
        expect(continued.rootNode.descendantsOfType('ERROR').at(-1)!.endIndex).toBe(continuedSource.length);
      } finally {
        continued.delete();
      }
    }
    for (const ending of ['\n', '\n \\\n']) {
      const commented = parser.parse('x=$(( $(case a in a) :;; esac )) # trailing comment' + ending)!;
      try {
        expect(commented.rootNode.type).toBe('program');
        expect(commented.rootNode.descendantsOfType('subshell')).toHaveLength(0);
        expect(commented.rootNode.descendantsOfType('command_substitution')[0]!.parent!.type).toBe('ERROR');
        expect(commented.rootNode.descendantsOfType('comment')[0]!.text).toBe('# trailing comment');
      } finally {
        commented.delete();
      }
    }
  } finally {
    tree.delete();
    parser.delete();
  }
});
