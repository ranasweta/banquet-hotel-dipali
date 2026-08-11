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
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | optional; web push for the installed app. Generate once with `npx web-push generate-vapid-keys`. Without both, the app still installs and push is silently inert — it never errors, so a missing key looks like "notifications don't work" |
| `VAPID_SUBJECT` | optional; `mailto:` address the push service can reach you at |

## The installable app (PWA)

The app installs from the browser — "Add to Home Screen" — and is the same deployment, so there
is no bundle to ship and no version to skew against the API. `app/manifest.ts` defines it and
`public/sw.js` is the service worker.

**The service worker caches `/_next/static/*` and nothing else**, on purpose: those filenames
carry a content hash so their bytes can never change. Pages and API responses are never cached —
every screen is permission-gated and reads live data, and a cached day sheet is a menu that has
since changed. There is no offline mode, by design.

Rotating the VAPID pair invalidates every existing subscription; staff must press "Notify me on
this phone" again. Dead endpoints prune themselves — a push refused with 404/410 deletes its row.

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
