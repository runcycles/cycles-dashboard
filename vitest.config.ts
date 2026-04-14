import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Vitest's default discovery globs include **/*.spec.ts, which
    // picks up Playwright specs in tests/e2e/. Playwright uses a
    // different runner (@playwright/test, not Vitest); those files
    // call `test(...)` from '@playwright/test' and can't execute
    // under Vitest. Exclude the directory so `npm test` only runs
    // Vitest suites. Playwright specs run via `npm run test:e2e`.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // Focus coverage on logic-heavy modules. View templates are declarative
      // and mostly auto-escaped by Vue — testing them has diminishing returns.
      // Per CLAUDE.md we target 95%+ on the files where bugs actually hurt.
      include: [
        'src/api/**',
        'src/stores/**',
        'src/composables/**',
        'src/utils/**',
      ],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        'src/types.ts',
        'src/main.ts',
      ],
      // Thresholds enforce the floor in CI. Raise these as tests accumulate.
      // Round 1 (client.ts + sanitize.ts) put us over the bar for api/ and
      // utils/ — this floor keeps regressions from sneaking through.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
})
