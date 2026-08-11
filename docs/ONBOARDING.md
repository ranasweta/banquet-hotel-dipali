# Joining this codebase

Written 11 Aug 2026 for a second developer, and updated the same day once the storage driver
landed — §6 describes what is built, not what to build. Read
`CLAUDE.md` first — it is the source of truth for conventions and business rules, and several
of them are non-obvious enough that ignoring one produces code that looks right and bills the
guest wrongly.

## 1. Your code is out of date — start from master

Production ran commit `5229c76` from 10 Aug until 11 Aug. Everything since was merged but never
deployed until the cutover. If your checkout predates that, you are missing about 3,000 lines
across 77 files, including changes to the billing arithmetic.

```bash
git checkout master && git pull
```

## 2. The database moved on 11 Aug 2026

It is no longer the `us-east-1` Neon project on `sjoffice7@gmail.com`. It is now
`ap-southeast-1` under `hdofficialroot@gmail.com`, beside Cloud Run — that move alone took a
query from ~296 ms to ~98 ms measured from India, and it was the single largest cause of the
app feeling slow.

**Your old `DATABASE_URL` still works and points at the dead database.** Nothing will tell you.
Get the current one from whoever holds the Neon login before you run anything.

## 3. Never point local dev at production

This has already cost real data. On 11 Aug we found:

- **32** Aadhaar images whose database rows are in production but whose bytes exist only on one
  laptop, because someone ran `next dev` with `DATABASE_URL` pointing at production while the
  storage driver — correctly — wrote locally;
- **17** junk enquiries (`jskdjl`, `falana`, `kana`) sitting in the production database.

Use a separate database. Neon branches are cheap; so is a second database on the same branch.

**Take your own `dipali_test`, do not share one.** The suite truncates and reseeds in
`beforeAll`, so two developers running tests against one database will watch each other's runs
fail with foreign-key violations on `events_created_by_fkey`. That happened repeatedly on 11 Aug
before the cause was understood, and it looks exactly like a real bug.

## 4. Environment

Copy `.env.example` to `.env.local`. Two of these are not free choices:

| Var | Note |
|---|---|
| `DATABASE_URL` | The NEW Singapore project. Never production for local work. |
| `TEST_DATABASE_URL` | **Your own** test database. |
| `SESSION_SECRET` | Any ≥32 chars locally. |
| `STORAGE_KEY` | **Must be byte-identical to production's**, or you cannot decrypt a single existing document. Get it from the same person as the database URL. **It must never be rotated** — every stored file becomes unreadable, permanently. |
| `SEED_PASSWORD` | Seeded users' initial password. |
| `CRON_SECRET` | Only needed to call the daily job by hand. |

Then `npx tsx db/migrate.ts --test` and run the suite.

**The suite is slow and the timeout is tight.** `vitest.config.ts` sets `testTimeout: 45_000`;
some integration files legitimately need more. If tests time out rather than fail an assertion,
raise it (`--testTimeout=180000`) before assuming you broke something.

## 5. How this deploys

There is **no Google Secret Manager**. GitHub Actions secrets are the mechanism:

- `.github/workflows/deploy.yml` is `workflow_dispatch` **only** — merging to master deploys
  nothing. Someone clicks Run workflow.
- Its `--set-env-vars` **replaces the entire runtime environment**. A variable that is not in
  that list does not exist on Cloud Run, however carefully it is set elsewhere. This is exactly
  how Aadhaar uploads ended up on an ephemeral disk (see below).
- Migrations are **not** run by the workflow. `npm run migrate` against production must finish
  before the deploy, or new code queries columns that do not exist.

## 6. Storage: done on 11 Aug, and why it looks the way it does

`lib/storage.ts` chooses a driver by asking one question — is a bucket configured?

```
GCS_BUCKET set  ->  Google Cloud Storage, private bucket `hdwed-docs` (asia-southeast1)
unset           ->  the local `storage/` directory
```

Vercel Blob is gone; so is `@vercel/blob`. Four things must stay true if you touch this.

**1. Encryption stays in this process.** AES-256-GCM happens *before* bytes leave (CLAUDE.md
rule 7). GCS is transport, not the security boundary — a bucket snapshot or a leaked URL must
yield ciphertext. Do not substitute Google-managed encryption for it.

**2. The bucket is private.** Uniform bucket-level access, public access prevention enforced.
Signed URLs are not needed: bytes are already served through a route that checks permission.
Nothing authenticates with a key file — Cloud Run's own service account holds Storage Object
Admin **on that bucket**, and the SDK picks it up through ADC.

**3. `assertPersistent` was dead on Cloud Run, and that cost real data.** It only checked
`process.env.VERCEL`, so on GCP an upload wrote to a container disk that forgets, reported
success, and lost the file on the next revision. **Two real Aadhaar images went that way on
11 Aug.** It now also checks `K_SERVICE`, and `tests/storage.test.ts` locks that behaviour —
if you are tempted to loosen the guard, read that test first.

**4. Object versioning is deliberately OFF.** Soft delete (7 days) is the recovery net
instead. Versioning would retain every *replaced* Aadhaar image indefinitely, which quietly
undoes the deletion that rule 7 requires. Bounded recovery, not permanent history.

### The two envelope formats

Both still exist, told apart by the shape of the `file_key` — a bucket key has a slash:

```
local   <uuid>.enc            [12B IV][16B tag][ciphertext],  content type in a .type sidecar
bucket  documents/<uuid>.enc  [12B IV][16B tag][ciphertext of [2B len][type][bytes]]
```

So a row written by one driver still reads under the other. No migration ran: the 48 documents
that existed before the cutover were all created during testing and were discarded with the
Vercel project. If real files ever need moving between drivers it is a read, re-wrap and
re-upload, then a rewrite of `guest_documents.file_key` — not a copy.

### If you also store rendered PDFs

Write-once per invoice number. CLAUDE.md rule 6: editing a billed booking *supersedes* its
document and issues a new numbered version rather than mutating the one the guest holds.
Overwriting a stored PDF destroys the document in a guest's hand, which is what that rule
exists to prevent.

## 7. Also outstanding, not yours unless you take it

- **The old Neon project must survive.** `curly-violet-63131529` on `sjoffice7@gmail.com` holds
  the pre-cutover data and is the only rollback. Not before a week has passed.
- **Backups are not configured yet.** Neon PITR, and a restore that brings the database and the
  bucket to the same point — a `guest_documents` row without its object is a booking that
  cannot be confirmed.

The daily job is no longer outstanding: Cloud Scheduler job `hdwed-daily` (asia-southeast1,
`30 8 * * *` Asia/Kolkata) calls `POST /api/v1/cron/run` with the `x-cron-secret` header. It
lives in GCP, not in this repo, so changing the time leaves no trace here. Without it
`advanceEventStatuses` never runs, no event reaches `completed`, and nothing can be locked,
invoiced or billed — and nothing announces that.

## 8. Two habits that cost time on 11 Aug

**After a squash merge, branch fresh from master.** PR #11 squashed a commit onto master; the
branch carried on and the next merge silently reverted half of it — the function definitions
survived while the call sites reverted. It compiled, types passed, and only two
`no-unused-vars` *warnings* hinted at it. Dead code type-checks perfectly.

**On Windows, `pg_dump`/`pg_restore` options must come BEFORE the connection string.** getopt
stops parsing at the first positional argument, and the error ("too many command-line
arguments") does not say so.
