# @willbooster/tree-sitter-bash

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-bash.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-bash)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-bash.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-bash)
[![Test](https://github.com/WillBooster/tree-sitter-bash/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-bash/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.45.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

Bash grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash). We are grateful to its authors and
contributors. This is not an official release of that project.

This fork aims to parse scripts exactly as bash runs them, so that tools can tell code from data in untrusted
scripts. It fixes parsing bugs and raises conformance with bash, checked by differential tests against bash itself.
As a result, its syntax trees differ from the original grammar's; review your queries when migrating.

## Usage

The npm package ships `tree-sitter-bash.wasm` for
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter) 10.0.2 or later in the 10.x series,
a peer dependency.
The parser carries the ABI number of WillBooster/tree-sitter (`0x57420007`), so only that runtime loads it; the
original tree-sitter runtime rejects it, and earlier WillBooster runtime ABIs do too:

```sh
npm install @willbooster/tree-sitter-bash @willbooster/web-tree-sitter@^10.0.2
```

In Node.js and Bun, load the grammar from its path:

```js
import { fileURLToPath } from 'node:url';
import { Language, Parser } from '@willbooster/web-tree-sitter';

await Parser.init();
const parser = new Parser();
const wasmPath = fileURLToPath(import.meta.resolve('@willbooster/tree-sitter-bash/tree-sitter-bash.wasm'));
parser.setLanguage(await Language.load(wasmPath));
const tree = parser.parse('cat <<EOF; echo done\n$(date)\nEOF\n');
```

In browsers, serve both `.wasm` files and pass their URLs; with Vite, for example:

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import bashUrl from '@willbooster/tree-sitter-bash/tree-sitter-bash.wasm?url';

await Parser.init({ locateFile: () => runtimeUrl });
const parser = new Parser();
parser.setLanguage(await Language.load(bashUrl));
```

Cloudflare Workers do not allow compiling Wasm at run time, so import both `.wasm` files as modules, which Wrangler
precompiles, and pass them to `Parser.init` and `Language.load`. This works with and without the `nodejs_compat`
flag:

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';
import bash from '@willbooster/tree-sitter-bash/tree-sitter-bash.wasm';

await Parser.init({ wasmModule: runtime });
const parser = new Parser();
parser.setLanguage(await Language.load(bash));
```

The package also ships the queries in `queries/` and the node types in `src/node-types.json`.

Upgrade `@willbooster/web-tree-sitter` to 10.0.2 or later in the 10.x series when upgrading this package. Recovery trees
for malformed scripts can differ across runtime versions, so review consumers that depend on the exact shape of
`ERROR` nodes.

Inside backquotes, the text of a node is the source text: consumers that read the value of a word or a string there
remove a backslash before `$`, a backquote, or a backslash (and before `"` when the backquotes are inside double quotes)
before they remove quotes and escapes as usual. Ordinary word and double-quoted string scanning account for those
removals when recognizing expansions, quotes, blanks, and shell operators. Backquotes that delimit the substitution
retain their source escape parity. Source continuations inside ordinary words and double-quoted strings are removed
before the resulting command text is parsed. Continuations around deferred heredoc bodies, heredoc text, parameter
expansions, regexes, nested backquotes, and PID expansions split by a removed escape retain their existing parsing
limitations.

## Development

```sh
mise install
bun install --frozen-lockfile
bun playwright install chromium
bun run build/ci
bun run verify
bun run test
```

- [Parser generation and validation](docs/development.md): read before changing grammar inputs, refreshing examples, or reproducing a fuzz or differential failure.

## References

- [Bash man page](http://man7.org/linux/man-pages/man1/bash.1.html#SHELL_GRAMMAR)
- [Shell command language specification](http://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- [mvdan/sh - a shell parser in go](https://github.com/mvdan/sh)
