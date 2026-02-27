import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Ratchets, set at the level the suite currently reaches. They exist to
      // stop coverage sliding backwards, so raise them when it improves and
      // never lower them to make a change fit.
      thresholds: {
        statements: 82,
        branches: 71,
        functions: 91,
        lines: 85,
      },
    },
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
