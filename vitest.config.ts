import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      // Mirror the tsconfig "@/*" path so route handlers and libs resolve under Vitest.
      { find: /^@\//, replacement: root },
      // The "server-only" package throws unless bundled with an RSC boundary; the tests
      // run in plain node, so stub it. The real client/server guard is unaffected.
      { find: /^server-only$/, replacement: `${root}tests/stubs/server-only.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'db/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests truncate and reseed; they must not race each other.
    fileParallelism: false,
    // Integration tests make many sequential round trips to a remote database; the 5s
    // default is for pure unit tests. Fast tests still finish fast — this only raises
    // the ceiling, with headroom for latency spikes on a shared remote DB. The seed
    // hook gets more (a full reseed is ~15s remote).
    testTimeout: 45_000,
    hookTimeout: 90_000,
  },
})
