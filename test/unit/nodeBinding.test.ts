import { test } from 'bun:test';

import { expectToSucceed } from './run.js';

const Timeout = 60_000;

test('loads the grammar through the Node.js binding', () => {
  expectToSucceed(['node', '--test', 'bindings/node/binding_test.js'], Timeout);
}, Timeout);
