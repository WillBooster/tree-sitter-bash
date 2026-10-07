# @willbooster/tree-sitter-bash

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-bash.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-bash)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-bash.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-bash)
[![Test](https://github.com/WillBooster/tree-sitter-bash/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-bash/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.28.8-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

Bash grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash). We are grateful to its authors and
contributors. This is not an official release of that project.

This fork aims to parse scripts exactly as bash runs them, so that tools can tell code from data in untrusted
scripts. It fixes parsing bugs and raises conformance with bash, checked by differential tests against bash itself.
As a result, its syntax trees differ from the original grammar's; review your queries when migrating.

## Usage

The npm package ships `tree-sitter-bash.wasm` for
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter) 1.3.0 or later, a peer dependency:

```sh
npm install @willbooster/tree-sitter-bash @willbooster/web-tree-sitter
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

## Development

```sh
mise install
bun install --frozen-lockfile
bun playwright install chromium
bun run build/ci
bun run test
script/parse-examples
```

The scripts and tests generate, build, test, and parse with `script/tree-sitter`, the tree-sitter CLI of the
WillBooster/tree-sitter runtime version that `package.json` pins as `@willbooster/web-tree-sitter`, since the generator
and the runtime of upstream's CLI are not the ones this package ships with. Its first run downloads that CLI from the
runtime's GitHub Release, or builds it with `cargo` (whose build runs the CMake that `mise.toml` pins) when the download fails or the release has no
binary that runs here. Run other CLI commands through it as well (e.g. `script/tree-sitter parse script.sh`).

`bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK);
- an incremental-parsing check (`test/unit/incremental.test.ts`): `script/fuzz-corpus` runs `tree-sitter fuzz`, which
  edits each corpus case at random, reparses it, undoes the edits, and reparses again. `TREE_SITTER_SEED`,
  `TREE_SITTER_ITERATIONS`, and `TREE_SITTER_EDITS` run other or more edits. It also applies edits that random ones
  rarely reach and compares each incremental reparse with a fresh parse;
- a check that real-world scripts cloned into `examples/` fail to parse exactly as listed in
  `script/known-failures.txt`. The first run clones them, which takes a few minutes. The example repositories are
  pinned to commits in `script/parse-examples`. After a grammar change or a moved pin alters that list,
  `script/parse-examples` rewrites it; review its diff before committing;
- a differential test (`test/unit/differential.test.ts`, with helpers in `test/helpers/differential`) that generates
  scripts and runs them with the bash that `mise.toml` pins. It checks that the syntax tree shows exactly the commands
  bash runs, with as many words and the same value for each word without expansions, and that the tree has no
  `ERROR` or `MISSING` node for a script bash accepts. A failure prints the seed; `DIFFERENTIAL_SEED` and
  `DIFFERENTIAL_CASES` run other or more scripts. It loads the Wasm build through @willbooster/web-tree-sitter, which
  `bun run build/ci` rebuilds after regenerating the parser;
- a performance check (`test/unit/performance.test.ts`) that a long line parses in linear time, since consumers
  parse untrusted scripts;
- checks that the Wasm build parses in Chromium (`test/unit/web.browser.test.ts`) and in Cloudflare Workers with and
  without Node.js compatibility (`test/unit/workers.test.ts`, with the Worker in `test/fixtures/worker`), loading it as
  the Usage section shows.

The tests and `script/parse-examples` compile the parser into `.tmp/tree-sitter-lib` rather than the CLI's cache shared
by every checkout; `script/fuzz-corpus` and the targeted edits of the incremental check build a parser of their own
for each run and delete it afterwards.

CI also fuzzes the parser with libFuzzer and sanitizers (`.github/workflows/robustness.yml`).

### References

- [Bash man page](http://man7.org/linux/man-pages/man1/bash.1.html#SHELL_GRAMMAR)
- [Shell command language specification](http://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- [mvdan/sh - a shell parser in go](https://github.com/mvdan/sh)
