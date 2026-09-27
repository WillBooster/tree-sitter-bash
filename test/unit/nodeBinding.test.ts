import { testCommand } from './run.js';

testCommand(
  'loads the grammar through the Node.js binding',
  ['node', '--test', 'bindings/node/bindingTest.js'],
  60_000
);
