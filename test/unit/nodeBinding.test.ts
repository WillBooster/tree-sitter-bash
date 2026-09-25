import { test } from 'bun:test';

import { expectToSucceed } from './run.js';

test('loads the grammar through the Node.js binding', () => {
  expectToSucceed(['node', '--test', 'bindings/node/binding_test.js']);
}, 60_000);
