import { testCommand } from './run.js';

testCommand('parses the corpus in test/corpus as expected', ['bun', 'run', 'tree-sitter', 'test'], 300_000);
