import { testCommand } from './run.js';

// The package ships a Wasm build, whose C library differs from the native one (e.g. in `iswalpha`). The
// first run downloads the WASI SDK.
testCommand(
  'parses the corpus in test/corpus as expected with the Wasm build',
  ['bun', 'run', 'tree-sitter', 'test', '--wasm'],
  900_000
);
