/**
 * Runs one rollback script from db/rollback/ against a database.
 *
 * Separate from `migrate` on purpose. Migrations are discovered and applied automatically in
 * lexical order; a rollback is a deliberate act naming one file, so it lives outside that
 * directory and is never picked up by mistake.
 *
 * Usage: npx tsx db/rollback.ts db/rollback/0025_gm_bundled_approvals.down.sql
 *        npx tsx db/rollback.ts <file> --test     (uses TEST_DATABASE_URL)
 *
 * The whole file runs in ONE transaction, so a guard that raises inside it aborts everything
 * and the schema is left exactly as it was. The transaction is opened here rather than with
 * BEGIN/COMMIT in the .sql because postgres.js refuses explicit transaction control inside a
 * simple-protocol batch — the same reason migrate.ts wraps its migrations this way.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from './client'

async function main(): Promise<void> {
  const file = process.argv[2]
  if (!file) {
    throw new Error('Usage: npx tsx db/rollback.ts <path-to-.down.sql> [--test]')
  }
  const useTest = process.argv.includes('--test')
  const target = useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'
  const ddl = readFileSync(resolve(file), 'utf8')

  const sql = createClient(target)
  try {
    console.log(`Rolling back ${file} (${target})…`)
    await sql.begin(async (tx) => {
      // .simple(): the only protocol that takes a file of many statements, DO blocks and
      // $$-quoted function bodies in one go — the same reason migrate uses it.
      await tx.unsafe(ddl).simple()
    })
    console.log('Done.')
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
