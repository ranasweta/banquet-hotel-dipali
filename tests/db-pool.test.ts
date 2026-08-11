import { describe, expect, it, vi } from 'vitest'

/**
 * The `db` proxy must hand out ONE connection pool, and it must do so in production too.
 *
 * `db/drizzle.ts` memoises on `globalThis`, and the memo used to be skipped when
 * NODE_ENV was 'production' — which is every deployed request. Because the proxy calls
 * `getDb()` on every property access, that meant `db.select`, `db.insert`, `db.transaction`
 * each built a brand-new postgres.js pool that nothing ever closed. This test pins the
 * production path specifically; a dev-mode test would have passed throughout the bug.
 */
describe('db pool', () => {
  it('creates exactly one client no matter how often the proxy is touched (production)', async () => {
    const created: object[] = []
    vi.doMock('@/db/client', () => ({
      createClient: () => {
        const client = {}
        created.push(client)
        return client
      },
    }))

    const previousEnv = process.env.NODE_ENV
    // NODE_ENV is readonly in the Next type augmentation; the runtime value is what matters.
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    vi.resetModules()
    try {
      const { db } = await import('@/db/drizzle')
      // Property reads only — enough to trigger the proxy, without touching a database.
      void db.select
      void db.insert
      void db.transaction
      void db.select
    } finally {
      ;(process.env as Record<string, string>).NODE_ENV = previousEnv as string
      vi.doUnmock('@/db/client')
      vi.resetModules()
    }

    expect(created).toHaveLength(1)
  })
})
