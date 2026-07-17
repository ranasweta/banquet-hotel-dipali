import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'db/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests truncate and reseed; they must not race each other.
    fileParallelism: false,
  },
})
