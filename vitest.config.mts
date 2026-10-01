import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const BrowserTests = 'test/unit/**/*.browser.test.ts';

export default defineConfig({
  test: {
    // tsconfig.json declares the `vitest/globals` types, so the runner must provide those globals.
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/unit/**/*.test.ts'],
          exclude: [BrowserTests],
          // Several tests run the tree-sitter CLI, which builds the parser into one cache in this checkout.
          fileParallelism: false,
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
