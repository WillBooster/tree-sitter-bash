# @willbooster/tree-sitter-bash

[![CI][ci]](https://github.com/WillBooster/tree-sitter-bash/actions/workflows/ci.yml)
[![npm][npm]](https://www.npmjs.com/package/@willbooster/tree-sitter-bash)

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
bun run lint
bun run test
bun run tree-sitter generate
bun run tree-sitter test
script/parse-examples
```

`script/parse-examples` clones real-world scripts into `examples/`, parses them with the local
tree-sitter CLI, and rewrites `script/known-failures.txt`, the list of files that CI expects to fail.

### References

- [Bash man page](http://man7.org/linux/man-pages/man1/bash.1.html#SHELL_GRAMMAR)
- [Shell command language specification](http://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- [mvdan/sh - a shell parser in go](https://github.com/mvdan/sh)

[ci]: https://img.shields.io/github/actions/workflow/status/WillBooster/tree-sitter-bash/ci.yml?logo=github&label=CI
[npm]: https://img.shields.io/npm/v/%40willbooster%2Ftree-sitter-bash?logo=npm
