import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { ApiError, errorResponse } from './api'

/**
 * A malformed id in a URL must read as "not found", not as a crash.
 *
 * `/events/not-a-uuid` reaches Postgres, which raises 22P02 rather than returning no rows,
 * and that used to fall through to the generic 500 — showing staff the same "Something went
 * wrong" as a real outage for what is only a stale link, and turning every mistyped URL into
 * an alert once error monitoring is wired up.
 */
describe('errorResponse', () => {
  it('answers a malformed identifier with 404, like an id that matches nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })

    const res = errorResponse(err)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: { code: 'not_found', message: 'Not found' } })
    warn.mockRestore()
  })

  it('finds the code when Drizzle has wrapped the driver error in a cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const driver = Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
    const wrapped = Object.assign(new Error('Failed query: select ...'), { cause: driver })

    expect(errorResponse(wrapped).status).toBe(404)
    warn.mockRestore()
  })

  it('still reports a genuinely unexpected error as an opaque 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = errorResponse(new Error('the database is on fire'))

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: { code: 'internal', message: 'Something went wrong' },
    })
    // Never leak the internal message to the caller.
    expect(JSON.stringify(await errorResponse(new Error('secret detail')).json())).not.toContain(
      'secret detail',
    )
    error.mockRestore()
  })

  it('leaves ApiError and ZodError alone', async () => {
    const api = errorResponse(new ApiError(409, 'conflict', 'That slot is taken'))
    expect(api.status).toBe(409)

    const zod = errorResponse(
      new ZodError([{ code: 'custom', path: ['mobile'], message: 'Required' }]),
    )
    expect(zod.status).toBe(400)
    await expect(zod.json()).resolves.toEqual({
      error: { code: 'validation', message: 'mobile: Required' },
    })
  })

  it('does not spin on a self-referencing cause chain', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const looping = new Error('round and round')
    Object.assign(looping, { cause: looping })

    expect(errorResponse(looping).status).toBe(500)
    error.mockRestore()
  })
})
