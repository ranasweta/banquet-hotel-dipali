/**
 * Applies SQL migrations in order, each inside one transaction, tracked in
 * `schema_migrations`. Re-running is a no-op.
 *
 * db/schema.sql IS migration 0001 (CLAUDE.md: "Apply it as migration 0001"). It is
 * referenced here rather than copied into db/migrations/ so there is exactly one copy
 * of the DDL and no chance of the two drifting. Migrations 0002+ live in
 * db/migrations/ and are applied in lexical order after it.
 *
 * Usage: pnpm migrate            (uses DATABASE_URL)
 *        pnpm migrate --test     (uses TEST_DATABASE_URL)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createClient, type Sql } from './client'

const DB_DIR = resolve(import.meta.dirname)
const MIGRATIONS_DIR = join(DB_DIR, 'migrations')

type Migration = { id: string; path: string }

export function loadMigrations(): Migration[] {
  const later = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ id: name.replace(/\.sql$/, ''), path: join(MIGRATIONS_DIR, name) }))

  return [{ id: '0001_init', path: join(DB_DIR, 'schema.sql') }, ...later]
}

export async function migrate(sql: Sql, log: (m: string) => void = console.log): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `

  const applied = new Set(
    (await sql<{ id: string }[]>`SELECT id FROM schema_migrations`).map((r) => r.id),
  )

  const ran: string[] = []
  for (const m of loadMigrations()) {
    if (applied.has(m.id)) {
      log(`  = ${m.id} (already applied)`)
      continue
    }
    const ddl = readFileSync(m.path, 'utf8')
    await sql.begin(async (tx) => {
      // .simple() uses the simple query protocol, the only one that accepts a file
      // of many statements (and the $$-quoted functions and DO blocks) in one go.
      await tx.unsafe(ddl).simple()
      await tx`INSERT INTO schema_migrations (id) VALUES (${m.id})`
    })
    log(`  + ${m.id} applied`)
    ran.push(m.id)
  }
  return ran
}

async function main() {
  const useTest = process.argv.includes('--test')
  const sql = createClient(useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL')
  console.log(`Migrating (${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'})…`)
  try {
    const ran = await migrate(sql)
    console.log(ran.length ? `Done. ${ran.length} migration(s) applied.` : 'Done. Already up to date.')
  } finally {
    await sql.end()
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
