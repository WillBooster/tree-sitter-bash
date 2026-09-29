import path from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

// The same Worker with and without Node.js compatibility, since the package must run in both.
const configs = {
  'tree-sitter-bash-test': 'wrangler.jsonc',
  'tree-sitter-bash-test-no-nodejs-compat': 'wrangler.no-nodejs-compat.jsonc',
};

let server: TestHarness | undefined;

beforeAll(async () => {
  server = createTestHarness({
    workers: Object.values(configs).map((config) => ({
      configPath: path.join(import.meta.dirname, '../fixtures/worker', config),
    })),
  });
  await server.listen();
}, 120_000);

afterAll(async () => {
  await server?.close();
});

test.each(Object.keys(configs))('parses in Cloudflare Workers with the imported Wasm modules (%s)', async (name) => {
  const response = await server!.getWorker(name).fetch('http://localhost/', { method: 'POST', body: 'echo hi\n' });
  expect(await response.text()).toBe('(program (command name: (command_name (word)) argument: (word)))');
});
