// oxlint-disable unicorn/prefer-module -- Node tests the CommonJS binding with require.
const assert = require('node:assert');
const { test } = require('node:test');

const Parser = require('tree-sitter');

test('can load grammar', () => {
  const parser = new Parser();
  assert.doesNotThrow(() => parser.setLanguage(require('.')));
});
