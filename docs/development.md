# Parser generation and validation

## Regenerate the parser

Use `script/tree-sitter` for CLI commands so generation and native parsing match the Web runtime pinned in `package.json`.
Its first invocation downloads a matching release binary or builds it with Cargo; the source build needs the CMake pinned in `mise.toml`.

After changing `grammar.js`, `tree-sitter.json`, a corpus case, or a tracked example, run `bun run build/ci` and commit the generated `src/` files.
Stage added or removed examples with `git add -A examples` before generation: `script/generate` trains only on the Git-tracked example list.
See `script/generate` for profile inputs and temporary output paths.

## Refresh example results

Run `script/parse-examples` after changing the grammar, examples, or clone pins, and review the changes to `script/known-failures.txt` before committing.
The script's cloned checkouts are disposable; keep local work elsewhere.

## Reproduce incremental failures

Run `TREE_SITTER_SEED=<seed> bun run test test/unit/incremental.test.ts`.
`TREE_SITTER_ITERATIONS` and `TREE_SITTER_EDITS` control the number of random edits.
The fixed edit cases in that file also compare incremental parses with fresh parses.

## Reproduce differential failures

Run `DIFFERENTIAL_SEED=<seed> DIFFERENTIAL_CASES=<count> bun run test test/unit/differential.test.ts`.
The oracle uses the Bash version pinned in `mise.toml`.

## Browser and Workers checks

Install Chromium once with `bun playwright install chromium` before running `test/unit/web.browser.test.ts`.
Run `test/unit/workers.test.ts` to exercise both Workers compatibility modes.
