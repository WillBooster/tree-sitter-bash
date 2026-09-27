// oxlint-disable unicorn/prefer-module -- Tree-sitter loads this binding as CommonJS.
const root = require('node:path').join(__dirname, '..', '..');

module.exports =
  typeof process.versions.bun === 'string'
    ? // Support `bun build --compile` by being statically analyzable enough to find the .node file at build-time
      require(`../../prebuilds/${process.platform}-${process.arch}/tree-sitter-bash.node`)
    : require('node-gyp-build')(root);

try {
  module.exports.nodeTypeInfo = require('../../src/node-types.json');
} catch {}
