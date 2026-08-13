# Hotel Dipali Banquet Management System

## Running the tests

**The tests need a LOCAL Postgres 16.** Point them at a hosted database and they are slow and
flaky — one file took 270 seconds, individual tests 45–75, and different ones failed on
different runs purely from round-trip latency. Locally the same file takes 2 seconds and the
whole suite about 55. Flaky red is worse than slow red: it teaches everyone to ignore it.

It also removes a real hazard. `TEST_DATABASE_URL` and `DATABASE_URL` used to differ only by the
database NAME on the same host, and `seed --reset --force` destroys every event it finds. One
slip in an env var and that runs against production.

```
npm run db:setup     # start Postgres, create dipali_test, apply migrations
npm test             # 39 files, 408 tests, ~55s
```

`npm run db:start` / `npm run db:stop` control the server on their own. All three are idempotent
and none of them touch an existing database.

Set `TEST_DATABASE_URL=postgres://postgres@localhost:5432/dipali_test` in `.env.local` (see
`.env.example`). A suite with it unset does not fail — every DB-backed file **skips**, printing
a warning, so a green run with no database proves nothing.

**First time on a machine.** You need PostgreSQL 16 on PATH (`pg_ctl`, `psql`, `createdb`):
`scoop install postgresql16` on Windows, `brew install postgresql@16` on macOS,
`apt install postgresql-16` on Debian. If the data directory has never been initialised, run
`initdb -D <dir> -U postgres` once and set `PGDATA` to it — `db/local-pg.mjs` finds scoop's
default by itself and otherwise reads `PGDATA`.

## Deployment (Cloud Run)

Docker/image build command
```
podman build -t hdwed .
```


Auth artifact reg
```
gcloud auth print-access-token | podman login -u oauth2accesstoken --password-stdin asia-southeast1-docker.pkg.dev
```

Tag to artifact reg
```
podman tag hdwed asia-southeast1-docker.pkg.dev/hdofficial/hdwed/hdwed:v1
```

Push to artifact reg
```
podman push asia-southeast1-docker.pkg.dev/hdofficial/hdwed/hdwed:v1
```

TO pick up shell vars (linux/mac only)
```
source .env
```

Deploy command using shell vars
```
gcloud run deploy hdwed \
  --image=asia-southeast1-docker.pkg.dev/hdofficial/hdwed/hdwed:v1 \
  --region=asia-southeast1 \
  --port=3000 \
  --cpu=1 --memory=1Gi \
  --min-instances=1 --max-instances=1 \
  --allow-unauthenticated \
  --set-env-vars="^##^DATABASE_URL=${DATABASE_URL}##SESSION_SECRET=${SESSION_SECRET}##STORAGE_KEY=${STORAGE_KEY}##CRON_SECRET=${CRON_SECRET}##DB_POOL_MAX=10"
```