# syntax=docker/dockerfile:1.7
#
# Hotel Dipali BEMS — production image. Builds the Next.js standalone server.
#
#   docker build -t dipali .
#   docker run --env-file .env.prod -p 3000:3000 -v dipali-storage:/app/storage dipali
#
# Migrations are NOT in here — `pnpm migrate` is run from a workstation against
# DATABASE_URL. It still has to finish BEFORE a new image takes traffic, or the code will
# be querying columns that do not exist yet (docs/OPERATIONS.md).
#
# Debian slim rather than Alpine: sharp (pulled in by next/image) and the other native
# builds listed in pnpm-workspace.yaml have first-class glibc prebuilds, and musl is where
# that stops being boring. This app serves one hotel group — a larger image is free, an
# image that fails to optimise a logo at 9 PM is not.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=10.11.0

# ── builder ─────────────────────────────────────────────────────────────────────────────
# Needs NO database and NO secrets. db/drizzle.ts connects lazily behind a proxy, and every
# page under (app) reaches cookies() before anything else, which opts it out of static
# generation — so nothing touches DATABASE_URL or SESSION_SECRET at build time.
#
# It DOES need outbound network: app/layout.tsx pulls four faces through next/font/google,
# which downloads and self-hosts them during the build. An air-gapped builder will fail here.
FROM ${NODE_IMAGE} AS builder
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
# package.json declares no packageManager field, so the version is pinned here instead.
# If one is ever added, keep the two in step or corepack will quietly disagree with CI.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# Lockfile first, so editing a component does not re-resolve the dependency tree.
# pnpm-workspace.yaml carries the allowBuilds list (esbuild, sharp, unrs-resolver); without
# it pnpm 10 skips those build scripts and sharp arrives unusable.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── runner ──────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Kolkata
WORKDIR /app

# TZ is the hotel's, for logs and for any bare `new Date()`. It changes nothing that matters
# to correctness by design: lib/time.ts pins Asia/Kolkata explicitly, and the cron handler
# takes its date from toISOString() in UTC. Both stay right whatever the container is set to.

# The standalone bundle traces only the modules actually reached, but Next leaves the static
# assets and public/ for us to place beside it.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# The local document driver's directory, owned by the user that will write to it.
#
# READ THIS BEFORE DEPLOYING. lib/storage.ts falls back to ./storage whenever GCS_BUCKET is
# unset. Its assertPersistent() guard now fires on Cloud Run (K_SERVICE) and Vercel, but a
# plain container sets neither, so there it will still not fire. An unmounted /app/storage
# therefore accepts an Aadhaar upload, reports success, and loses the file on the next
# deploy. Because confirming an event requires both Aadhaar sides on record, that surfaces
# weeks later as "no booking can be confirmed", nowhere near the cause. Either set
# GCS_BUCKET, or mount a durable volume at /app/storage and back it up with the database
# (rule 7).
RUN install -d -o node -g node /app/storage

USER node
EXPOSE 3000

# No curl or wget in the slim image, and no /api/health in the app. /login is the one page
# that is entirely client-side, so this proves the server is serving without touching Postgres.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
