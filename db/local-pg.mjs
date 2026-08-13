/**
 * Starts, stops and prepares the LOCAL Postgres the tests run against.
 *
 * WHY THIS EXISTS. The suite used to point at the hosted (Neon) database, and it was both slow
 * and unreliable there — a single test file took 270 seconds, individual tests 45–75, and
 * different ones failed on different runs purely from round-trip latency. None of that was a
 * real failure, which is worse than a real one: it teaches everybody to ignore red. Against a
 * local server the same file takes 2 seconds and the whole suite about 55.
 *
 * It also removes a genuine hazard. TEST_DATABASE_URL and DATABASE_URL used to differ only by
 * the database NAME on the same host, and `seed --reset --force` destroys every event it finds.
 * One slip in an env var and that runs against production. A local server cannot be reached
 * from anywhere near prod.
 *
 * Usage:
 *   node db/local-pg.mjs start     start the server (idempotent)
 *   node db/local-pg.mjs stop      stop it
 *   node db/local-pg.mjs status    is it up?
 *   node db/local-pg.mjs setup     start + create the test database + migrate
 *
 * It shells out to pg_ctl/createdb from PATH, so any Postgres 16 install works — scoop, the
 * EDB installer, Homebrew, apt. It does NOT install Postgres; see README if the commands are
 * missing. PGDATA is honoured if set, otherwise the scoop default is tried.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TEST_DB = 'dipali_test'

/** The data directory: $PGDATA, else scoop's, else give up with something actionable. */
function dataDir() {
  if (process.env.PGDATA) return process.env.PGDATA
  const scoop = join(homedir(), 'scoop', 'persist', 'postgresql16', 'data')
  if (existsSync(join(scoop, 'PG_VERSION'))) return scoop
  throw new Error(
    'Cannot find the Postgres data directory. Set PGDATA to it, or run `initdb -D <dir> -U postgres` first.',
  )
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error?.code === 'ENOENT') {
    throw new Error(`\`${cmd}\` is not on PATH — install PostgreSQL 16 (see README).`)
  }
  return r
}

function isUp() {
  return run('pg_isready', ['-h', 'localhost', '-p', '5432', '-q']).status === 0
}

function start() {
  if (isUp()) return console.log('Postgres is already up on localhost:5432')
  const data = dataDir()
  const r = run('pg_ctl', ['-D', data, '-l', join(data, '..', 'pg.log'), '-w', 'start'])
  process.stdout.write(r.stdout || '')
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '')
    throw new Error('pg_ctl start failed — see the log above.')
  }
  console.log('Postgres up on localhost:5432')
}

function stop() {
  if (!isUp()) return console.log('Postgres is not running')
  const r = run('pg_ctl', ['-D', dataDir(), '-m', 'fast', '-w', 'stop'])
  process.stdout.write(r.stdout || '')
  console.log('Postgres stopped')
}

/** Creates the test database if it is missing. Never touches one that already exists. */
function ensureDb() {
  const exists =
    run('psql', ['-h', 'localhost', '-U', 'postgres', '-d', 'postgres', '-tAc',
      `SELECT 1 FROM pg_database WHERE datname='${TEST_DB}'`]).stdout?.trim() === '1'
  if (exists) return console.log(`Database ${TEST_DB} already exists`)
  const r = run('createdb', ['-h', 'localhost', '-U', 'postgres', TEST_DB])
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '')
    throw new Error(`Could not create ${TEST_DB}.`)
  }
  console.log(`Created ${TEST_DB}`)
}

const cmd = process.argv[2] ?? 'status'
try {
  if (cmd === 'start') start()
  else if (cmd === 'stop') stop()
  else if (cmd === 'status') console.log(isUp() ? 'up' : 'down')
  else if (cmd === 'setup') {
    start()
    ensureDb()
    // Migrating here rather than telling the reader to run a second command: a fresh database
    // with no schema is not a working test setup, and the gap between the two is where
    // "it says relation does not exist" comes from.
    //
    // tsx's CLI is run with THIS node, not through `npx`: on Windows npx is a .cmd, which
    // execFile refuses outright (EINVAL) unless you pass shell:true — and shell:true then
    // warns (DEP0190) for concatenating arguments. Resolving the entry point sidesteps both.
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
    execFileSync(process.execPath, [tsx, 'db/migrate.ts', '--test'], { stdio: 'inherit' })
    console.log('\nReady. `npm test` now runs against localhost.')
  } else {
    console.error(`Unknown command "${cmd}". Use: start | stop | status | setup`)
    process.exit(1)
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(1)
}
