/**
 * The driver-selection guard in lib/storage.ts (no database).
 *
 * This exists because the guard silently did nothing on Cloud Run: it only checked
 * `VERCEL`, so on GCP an Aadhaar upload wrote to the instance's memory, reported success,
 * and vanished with the next revision. Two real documents were lost that way on 11 Aug 2026.
 * Nothing else in the suite would notice that regression returning.
 */
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const STORAGE_DIR = resolve(process.cwd(), 'storage')

/** A valid AES-256 key — fixed, since nothing here depends on it being secret. */
const TEST_KEY = Buffer.alloc(32, 7).toString('base64')

/** Re-imports the module under a given environment; it reads env at call time, not import. */
async function withEnv(env: Record<string, string | undefined>) {
  vi.resetModules()
  vi.stubEnv('STORAGE_KEY', TEST_KEY)
  for (const name of ['GCS_BUCKET', 'K_SERVICE', 'VERCEL']) {
    vi.stubEnv(name, env[name] ?? '')
  }
  return import('@/lib/storage')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('assertPersistent', () => {
  it('refuses to write on Cloud Run when no bucket is configured', async () => {
    const { storeEncrypted } = await withEnv({ K_SERVICE: 'hdwed' })
    await expect(storeEncrypted(Buffer.from('aadhaar'), { contentType: 'image/jpeg' }))
      .rejects.toThrow(/GCS_BUCKET/)
  })

  it('refuses to write on Vercel when no bucket is configured', async () => {
    const { storeEncrypted } = await withEnv({ VERCEL: '1' })
    await expect(storeEncrypted(Buffer.from('aadhaar'), { contentType: 'image/jpeg' }))
      .rejects.toThrow(/does not survive/)
  })

  it('allows the local driver on a laptop, and round-trips through encryption', async () => {
    const { storeEncrypted, readDecrypted, deleteStored } = await withEnv({})
    const bytes = Buffer.from('front side of an aadhaar card')

    const { fileKey } = await storeEncrypted(bytes, { contentType: 'image/png' })
    try {
      // What lands on disk must not be the plaintext — encryption happens in-process.
      const onDisk = await import('node:fs/promises').then((fs) =>
        fs.readFile(join(STORAGE_DIR, fileKey)),
      )
      expect(onDisk.includes(bytes)).toBe(false)

      const read = await readDecrypted(fileKey)
      expect(read.bytes.equals(bytes)).toBe(true)
      expect(read.contentType).toBe('image/png')
    } finally {
      await deleteStored(fileKey)
      await rm(join(STORAGE_DIR, fileKey), { force: true })
    }
  })
})

describe('readDecrypted', () => {
  it('rejects a file key that tries to escape the storage directory', async () => {
    const { readDecrypted } = await withEnv({})
    await expect(readDecrypted('../../etc/passwd')).rejects.toThrow(/Invalid file key/)
    await expect(readDecrypted('documents/../../../etc/passwd')).rejects.toThrow(
      /Invalid file key/,
    )
  })
})
