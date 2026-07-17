import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Match db/client.ts: load .env.local (the project convention) as well as .env.
config({ path: ['.env.local', '.env'], quiet: true })

/**
 * Introspection only. db/schema.sql is the source of truth (CLAUDE.md) and is applied
 * by db/migrate.ts; `pnpm db:pull` reads the live database back into db/schema.ts for
 * query types. Never use drizzle-kit generate/push here — that would make the TS the
 * source of truth and silently diverge from the SQL.
 *
 * Drizzle cannot express the EXCLUDE USING gist constraint on room_allocations or the
 * audit/lock triggers. They live in SQL alone and are enforced by the database whether
 * or not the ORM knows about them.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  introspect: {
    casing: 'camel',
  },
})
