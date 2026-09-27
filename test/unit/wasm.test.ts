import { test } from 'bun:test';

import { expectToSucceed } from './run.js';

const Timeout = 900_000;

// The package ships a Wasm build, whose C library differs from the native one (e.g. in `iswalpha`). The
// first run downloads the WASI SDK.
test('parses the corpus in test/corpus as expected with the Wasm build', () => {
  expectToSucceed(['bun', 'run', 'tree-sitter', 'test', '--wasm'], Timeout);
}, Timeout);
