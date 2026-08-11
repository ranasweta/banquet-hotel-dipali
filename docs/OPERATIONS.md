# Operations & backup runbook

Operational notes for running Hotel Dipali BEMS in production. Written at M10.

## Environment

Required environment variables (see `.env.example`; never commit `.env.local`):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL 16 connection string (app + migrations) |
| `TEST_DATABASE_URL` | Separate database the test suite truncates/reseeds — never point at prod |
| `SESSION_SECRET` | iron-session cookie encryption key (≥ 32 chars) |
| `STORAGE_KEY` | base64 of 32 bytes — AES-256-GCM key for encrypted document storage |
| `SEED_PASSWORD` | initial password for seeded users (rotate after first login) |
| `CRON_SECRET` | optional; header secret so a scheduler can call `POST /cron/run` |
| `DB_POOL_MAX` | optional; postgres.js pool size (default 5) |

## Database backups (NFR-4)

The app stores everything in Postgres; **money is in paise, documents are encrypted files
referenced by `file_key`**, so a consistent backup must capture both the database and the
`storage/` directory (or object-storage bucket) together.

- **Managed Postgres (recommended):** enable the provider's automated daily snapshots and
  **point-in-time recovery (PITR)**. Neon, RDS and Cloud SQL all offer PITR — set retention to
  at least 30 days. This satisfies NFR-4 with no app-side cron.
- **Self-managed:** schedule `pg_dump --format=custom` daily to off-box storage, plus WAL
  archiving for PITR. Test a restore quarterly.
- **Document storage:** back up `storage/*.enc` alongside the DB (or use a versioned bucket).
  The files are encrypted at rest; `STORAGE_KEY` is required to read them — **store the key in
  a secrets manager, not in the backup**, or the backup is unreadable *and* a key leak exposes
  every document.

## Restore

1. Restore the database snapshot (or PITR to a timestamp).
2. Restore `storage/` to the same point.
3. Confirm `STORAGE_KEY` and `SESSION_SECRET` match the originals (rotating either invalidates
   documents / sessions respectively).
4. Smoke-test: log in, open a locked event's invoice, view a KYC document.

## Migrations

Schema is SQL-first. `db/schema.sql` is migration `0001`; later changes are `db/migrations/*.sql`
applied in order by `pnpm migrate`. Pre-launch the team folded changes into `0001` and rebuilt;
**post-launch, never edit `0001` — add a new numbered migration** so production upgrades forward
without a rebuild.

## Moving the database to Singapore (cutover runbook)

Cloud Run is in `asia-southeast1` and the database was in `aws-us-east-1` — roughly 230 ms per
query, before the database does any work. Neon cannot change a project's region, so the move is
a new project plus a dump and restore.

| | Project | Region |
|---|---|---|
| From | `curly-violet-63131529` ("Banquet") | `aws-us-east-1` |
| To | `hidden-resonance-76799876` ("Banquet SG") | `aws-ap-southeast-1` |

Both PG 16, both with a `neondb` database owned by `neondb_owner`, so only the host changes.

**Before you start:** PostgreSQL **16** client tools (`pg_dump` must be ≥ the server's major
version). No local install? `docker run --rm -v "$PWD:/w" -w /w postgres:16 pg_dump …`.

### 1. Take the connection strings

```bash
ORG=org-fragrant-brook-41215212
npx neonctl branches list --project-id curly-violet-63131529 --org-id $ORG   # confirm the branch name
npx neonctl connection-string <branch> --project-id curly-violet-63131529 --database-name neondb --org-id $ORG
npx neonctl connection-string main    --project-id hidden-resonance-76799876 --database-name neondb --org-id $ORG
```

These contain live credentials. Keep them out of chat, tickets and commits.

### 2. Stop writes

Take the app down for the window — scale Cloud Run to zero, or put up a maintenance page.
**Do not dump a live database here.** A booking taken between the dump starting and the cutover
finishing exists only in the old database and is lost, and in this system a booking is money.

### 3. Dump and restore

```bash
pg_dump "$OLD_URL" --format=custom --no-owner --no-privileges --file=banquet.dump
pg_restore --dbname="$NEW_URL" --no-owner --no-privileges --single-transaction banquet.dump
```

`--single-transaction` is not optional. A partial restore is the dangerous outcome: it can leave
the schema looking complete while missing a constraint, and the missing constraint is the thing
that prevents double-booking.

### 4. Verify BEFORE repointing anything

```sql
-- 1. The two clash-proofing constraints. If this returns fewer than two rows, STOP —
--    the database will silently accept two weddings in one hall.
SELECT conname, conrelid::regclass FROM pg_constraint WHERE contype = 'x';

-- 2. Event codes must not go backwards, or you reissue a code a guest already has.
SELECT last_value FROM event_code_seq;

-- 3. The append-only audit guard.
SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal;

-- 4. Migrations, and a row count to compare against the old database.
SELECT count(*) FROM schema_migrations;
SELECT 'events' t, count(*) FROM events
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'audit_log', count(*) FROM audit_log
UNION ALL SELECT 'guest_documents', count(*) FROM guest_documents;
```

Run 2 and 4 against **both** databases and compare. Equal counts and an equal `last_value` are
the only evidence the restore was complete.

### 5. Repoint, in this order

1. `.env.local` — so a local run cannot keep writing to the old database.
2. Vercel project env (Production **and** Preview).
3. GitHub Actions secret `DATABASE_URL` — the Cloud Run deploy reads it, and its
   `--set-env-vars` replaces the whole environment, so a stale value here silently survives.
4. Redeploy, bring traffic back.

### 6. Smoke test

Sign in, open the calendar, open a booking's Payment review, and view a KYC document. Then make
one throwaway enquiry and delete it — a read-only check does not prove writes work.

### 7. Keep the old project

Do not delete `curly-violet-63131529` for at least a week. It is the rollback: repoint
`DATABASE_URL` back and redeploy. Once deleted, anything written after the cutover is the only
copy, and there is no way back.

### The test database has already moved (11 Aug 2026)

`dipali_test` now lives on the Singapore project — it held nothing worth preserving, so it was
created fresh and migrated rather than dumped. All 26 migrations applied, and the verification
above passes on it: both exclusion constraints present, `audit_no_update` on `audit_log`,
`event_code_seq` at its start value.

Measured from a laptop in India, median of twelve queries after warm-up:

| | Median | Min | Max |
|---|---|---|---|
| `us-east-1` (Virginia) | 296 ms | 230 | 312 |
| `ap-southeast-1` (Singapore) | **101 ms** | 89 | 117 |

`tests/user-admin.integration.test.ts` — same ten tests, same code — went from **132.7 s to
60.5 s**. That is why the suite was tripping the 45 s per-test timeout.

**Production will gain far more than this 2.9×.** These numbers are India → database. The
production path is Cloud Run → database, and once both sit in Singapore that is a same-region
hop of a few milliseconds rather than 101 ms. The figures above are the floor of the
improvement, not the ceiling.

## The daily job (`POST /cron/run`)

Generates wedding payment reminders and surfaces stale enquiries (M7). Schedule it once a day
with the `CRON_SECRET` header, e.g. a cron hitting `POST /api/v1/cron/run`. Idempotent.

## Auth hardening

Login is rate-limited (10 attempts / 5 min per mobile+IP; M10). Behind a proxy, ensure
`x-forwarded-for` carries the real client IP. The limiter is in-process — for multiple app
instances, move it to Redis (same interface in `lib/rate-limit.ts`).

## Before going live — open items

These are flagged in `docs/SEED_ASSUMPTIONS.md` and must be resolved with the hotel:

- **GST rates per charge head** and the **hotel GSTIN** are placeholders — do not file invoices
  until the tax consultant confirms them (D9, open question 5).
- **Terms & Conditions** text is a placeholder — Admin must set it before finalising any
  invoice (`settings.terms_and_conditions`).
- Several **seed values are invented** (Regency room breakdown, some capacities, dormitory
  pricing) — see SEED_ASSUMPTIONS §A. Confirm before real bookings.
