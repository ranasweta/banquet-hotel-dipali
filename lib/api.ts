/**
 * JSON response helpers for route handlers. The API contract fixes the error shape as
 * `{ error: { code, message } }` with a proper HTTP status; every handler goes through
 * here so that shape is uniform.
 */
import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 401 — not signed in. */
export const unauthorized = (message = 'Not signed in') =>
  new ApiError(401, 'unauthorized', message)

/** 403 — signed in but lacking the required permission. */
export const forbidden = (message = 'You do not have permission to do that') =>
  new ApiError(403, 'forbidden', message)

/** 404 — target does not exist. */
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message)

/** 409 — a constraint race or conflicting state (e.g. a taken slot, a duplicate). */
export const conflict = (message: string) => new ApiError(409, 'conflict', message)

/** 400 — the request itself is malformed or fails validation. */
export const badRequest = (message: string) => new ApiError(400, 'bad_request', message)

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status })
}

/**
 * Postgres 22P02, `invalid_text_representation` — raised when a value cannot be cast to the
 * column's type, which in practice means a URL segment that is not a UUID.
 *
 * Walks the cause chain: Drizzle wraps a driver error in its own "Failed query" error and
 * keeps the original on `cause`, so the code is one level down rather than on `err` itself.
 * Bounded, so a self-referencing cause cannot spin.
 */
function isInvalidTextRepresentation(err: unknown): boolean {
  let cursor: unknown = err
  for (let depth = 0; cursor && depth < 5; depth += 1) {
    if ((cursor as { code?: unknown }).code === '22P02') return true
    cursor = (cursor as { cause?: unknown }).cause
  }
  return false
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status })
  }
  if (err instanceof ZodError) {
    const first = err.issues[0]
    const where = first?.path.join('.') || 'body'
    return NextResponse.json(
      { error: { code: 'validation', message: `${where}: ${first?.message ?? 'invalid input'}` } },
      { status: 400 },
    )
  }
  // A malformed id in the URL — `/events/not-a-uuid` — reaches Postgres, which refuses the
  // cast and raises 22P02. Left alone that surfaced as the generic 500 below, which is the
  // same alarming "Something went wrong" the staff see during a real outage, for what is
  // only a stale bookmark or a mistyped link. Answer it exactly as a well-formed id that
  // matches nothing: 404. Handled here rather than by adding a UUID check to forty route
  // handlers. Still logged, but as a warning, so a genuine bug that puts a bad value into a
  // query stays visible without being alarmed on as a crash.
  if (isInvalidTextRepresentation(err)) {
    console.warn('Malformed identifier in request:', err)
    return NextResponse.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 })
  }
  // Unknown/unexpected: log server-side, return an opaque 500 (never leak internals).
  console.error('Unhandled route error:', err)
  return NextResponse.json(
    { error: { code: 'internal', message: 'Something went wrong' } },
    { status: 500 },
  )
}

/**
 * Wraps a route handler so thrown ApiError/ZodError become the right response and
 * anything unexpected becomes a clean 500. Handlers can then just throw.
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args)
    } catch (err) {
      return errorResponse(err)
    }
  }
}
