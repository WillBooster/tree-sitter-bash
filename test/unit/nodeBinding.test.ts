import { testCommand } from './run.js';

testCommand('loads the grammar through the Node.js binding', ['node', '--test', 'bindings/node/binding_test.js'], 60_000);
