# @willbooster/tree-sitter-bash

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-bash.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-bash)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-bash.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-bash)
[![Test](https://github.com/WillBooster/tree-sitter-bash/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-bash/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.20.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

Bash grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), rewritten from
[tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash). The syntax trees differ from the
original grammar's.

- Heredoc bodies are parsed wherever bash reads them: from the newline that ends the line holding the `<<` operator,
  in operator order. Any statement may follow the operator on that line (`cat <<EOF; echo done`), and several heredocs
  may share a line. A `heredoc_body` node appears as an extra next to the command that opened it. A heredoc whose
  delimiter does not fit the parser's 1 KiB scanner state is an `ERROR` rather than a guessed body.
- Redirections stay inside the command they belong to, in source order (`npm > out run x`), and a command may
  consist of assignments and redirections only.
- `$((…))` is always an arithmetic expansion, including inside heredoc bodies; escaped `\$` and `` \` `` are literal.
- A newline is a statement terminator only where one may end a statement; elsewhere it is whitespace.

## Usage

```js
const Parser = require('tree-sitter');
const Bash = require('@willbooster/tree-sitter-bash');

const parser = new Parser();
parser.setLanguage(Bash);
const tree = parser.parse('cat <<EOF; echo done\n$(date)\nEOF\n');
```

## Development

```sh
mise install
bun install --frozen-lockfile
bun run build/ci
bun run test
script/parse-examples
```

`bun run test` runs:

- the corpus in `test/corpus`;
- the Node.js binding test;
- a check that real-world scripts cloned into `examples/` fail to parse exactly as listed in
  `script/known-failures.txt`. The first run clones them, which takes a few minutes. The example repositories are
  pinned to commits in `script/parse-examples`. After a grammar change or a moved pin alters that list,
  `script/parse-examples` rewrites it; review its diff before committing;
- a differential test (`test/helpers/differential`) that generates scripts, runs them with the bash that
  `mise.toml` pins, and checks that the syntax tree shows exactly the commands bash runs, with as many words and
  the same value for each word without expansions. A failure prints the seed; `DIFFERENTIAL_SEED` and `DIFFERENTIAL_CASES` run other or more scripts. It loads the
  Node.js addon, which `bun run build/ci` rebuilds after regenerating the parser.

### References

- [Bash man page](http://man7.org/linux/man-pages/man1/bash.1.html#SHELL_GRAMMAR)
- [Shell command language specification](http://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- [mvdan/sh - a shell parser in go](https://github.com/mvdan/sh)
