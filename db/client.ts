import { config } from 'dotenv'
import postgres from 'postgres'

// Next.js loads .env.local automatically; plain node scripts (migrate, seed, tests) do
// not, and `dotenv/config` alone only reads `.env`. Load the same files Next does, in
// the same precedence order, so one .env.local serves the app and the scripts alike.
// Real environment variables always win over both.
config({ path: ['.env.local', '.env'], quiet: true })

/**
 * Resolves the connection string. Scripts and tests pass an explicit env var name
 * so a test run can never be pointed at the dev database by accident.
 */
export function connectionString(envVar: 'DATABASE_URL' | 'TEST_DATABASE_URL' = 'DATABASE_URL'): string {
  const url = process.env[envVar]
  if (!url) {
    throw new Error(
      `${envVar} is not set. Copy .env.example to .env.local and set it to a PostgreSQL 16 connection string.`,
    )
  }
  return url
}

/**
 * int8 -> JS number, not BigInt and not string.
 *
 * Every int8 in this schema is money in paise (CLAUDE.md rule 1), and paise stay far
 * below Number.MAX_SAFE_INTEGER — 9.007e15 paise is Rs. 90 billion, orders of magnitude
 * past any banquet bill. So a number is exact here, and it keeps the DB agreeing with
 * `Paise = number` in lib/money.ts. postgres.js would otherwise hand back a string, and
 * postgres.BigInt would hand back a BigInt; either would fail assertPaise() and poison
 * the invoice arithmetic.
 *
 * The parse guard means that if a value ever DOES exceed the safe range, it throws
 * loudly instead of silently losing precision on someone's bill.
 */
const paiseAsNumber = {
  to: 20,
  from: [20],
  serialize: (v: number) => String(v),
  parse: (v: string) => {
    const n = Number(v)
    if (!Number.isSafeInteger(n)) {
      throw new RangeError(
        `int8 value ${v} exceeds JS safe-integer range. Money is paise and should never ` +
          `get this large — check for a unit error (rupees stored as paise?).`,
      )
    }
    return n
  },
}

export function createClient(envVar: 'DATABASE_URL' | 'TEST_DATABASE_URL' = 'DATABASE_URL') {
  return postgres(connectionString(envVar), {
    // Overridable so a single-connection server (e.g. an embedded Postgres used for
    // local verification) can be driven without connection resets.
    //
    // WORTH RAISING FOR LOCAL DEV against a remote database (4 Aug 2026). Several endpoints
    // now fetch their sources concurrently — `notificationsFor` reads eleven — and five
    // connections make those queries queue behind one another again. Measured against Neon
    // us-east-1 from India, /notifications went from ~17s to ~1.4s at DB_POOL_MAX=24 with no
    // other change. Leave the DEFAULT alone: on Vercel every serverless instance holds its
    // own pool, so a large max multiplied by warm instances is how a Postgres connection
    // limit gets exhausted — and production does not need it, the app and the database
    // being in the same region.
    max: Number(process.env.DB_POOL_MAX ?? 5),
    // Hand back idle connections before the other end drops them. The pool now lives for
    // the whole life of a serverless instance (db/drizzle.ts), and a Vercel instance stays
    // warm far longer than Neon waits before autosuspending its compute — which kills every
    // open socket. Without this, the first request after a quiet spell can be handed a dead
    // connection and fail, which is the "it worked, then after a while it didn't" shape.
    // Sixty seconds is comfortably under Neon's five-minute idle window; reconnecting costs
    // one in-region handshake on the next query, which is a few milliseconds.
    idle_timeout: 60,
    types: { bigint: paiseAsNumber },
    onnotice: (notice) => {
      // 42P07 is "relation already exists, skipping" from CREATE ... IF NOT EXISTS —
      // expected every time a migration re-runs. Everything else is worth seeing, but
      // as one line: postgres.js would otherwise dump the whole notice object, which
      // reads like a stack trace.
      if (notice.code === '42P07') return
      console.warn(`postgres notice [${notice.code}]: ${notice.message}`)
    },
  })
}

export type Sql = ReturnType<typeof createClient>

/** The scoped client handed to a `sql.begin(...)` callback. */
export type Tx = postgres.TransactionSql<{ bigint: number }>
