/**
 * The Drizzle client the app queries through. `db/schema.sql` is the source of truth
 * (CLAUDE.md); `db/schema.ts` is introspected from it via `pnpm db:pull` and gives these
 * queries their types. The underlying postgres.js client is `db/client.ts`, so int8
 * comes back as a number (paise) here exactly as it does in the seed.
 *
 * Two deliberate behaviours:
 *
 * 1. Lazy connect. The pool is created on first query, not at import. So importing this
 *    module (transitively, via a route handler) on a machine with no database does not
 *    throw — the offline unit tests keep passing, and a test that needs a DB can skip
 *    cleanly before ever touching `db`.
 *
 * 2. Under Vitest it targets TEST_DATABASE_URL, never DATABASE_URL. Route handlers
 *    import this same `db`, so an integration test drives them against the throwaway
 *    test database and can never touch dev data.
 *
 * Singleton, in EVERY environment. It is memoised on `globalThis` because Next re-evaluates
 * modules on each dev hot reload, but the memo must not be conditional on NODE_ENV — the
 * usual Prisma-style `if (NODE_ENV !== 'production')` idiom pairs that global with a
 * module-level const, and there is no module-level const here. Skipping the memo in
 * production meant the proxy below built a fresh, never-closed pool on every property
 * access: `db.select`, `db.insert`, `db.transaction` were a connection each, so one
 * dashboard render opened twenty-odd. That is a TCP+TLS handshake per query, and
 * eventually a 500 when the connection limit is reached. See tests/db-pool.test.ts.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { createClient, type Sql } from './client'
import * as schema from './schema'

const globalForDb = globalThis as unknown as {
  __sql?: Sql
  __db?: PostgresJsDatabase<typeof schema>
}

function getDb(): PostgresJsDatabase<typeof schema> {
  if (globalForDb.__db) return globalForDb.__db
  const envVar = process.env.VITEST ? 'TEST_DATABASE_URL' : 'DATABASE_URL'
  const sql = globalForDb.__sql ?? createClient(envVar)
  const instance = drizzle(sql, { schema })
  globalForDb.__sql = sql
  globalForDb.__db = instance
  return instance
}

// A proxy so `db` is a stable export but the connection is deferred to first use.
// Methods are bound to the real instance so Drizzle's internal `this` is correct.
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    const real = getDb()
    const value = Reflect.get(real as object, prop, receiver)
    return typeof value === 'function' ? value.bind(real) : value
  },
})

export { schema }
