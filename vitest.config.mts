import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const BrowserTests = 'test/unit/**/*.browser.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/unit/**/*.test.ts'],
          exclude: [BrowserTests],
          // Several tests run the tree-sitter CLI, which builds the parser into a shared cache.
          fileParallelism: false,
          // test/unit/performance.test.ts times parses in process CPU time, which counts only that test file while
          // each worker is a process of its own; threads would share it with other test files.
          pool: 'forks',
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: [BrowserTests],
          browser: {
            enabled: true,
            headless: true,
            instances: [{ browser: 'chromium' }],
            provider: playwright(),
          },
        },
      },
    ],
  },
});
