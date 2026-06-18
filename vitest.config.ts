import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Co-locate test files next to the modules they cover. Keeps each
    // module's tests one folder away from its source — easier to find,
    // easier to refactor together.
    include: ['src/**/*.test.ts'],
    // Use plain node environment; no jsdom / happy-dom needed since we're
    // testing a Node library.
    environment: 'node',
    // Fail fast in CI but keep parallelism on for local iteration speed.
    pool: 'forks',
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
  },
});
