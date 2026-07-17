import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Encrypted-at-rest local document storage for KYC/Aadhaar (CLAUDE.md rule 7). Files are
 * AES-256-GCM encrypted with STORAGE_KEY before hitting disk; only a `file_key` (an
 * opaque path) is stored in guest_documents. In production this would be object storage;
 * the interface is the same. NEVER log document bytes or Aadhaar data.
 *
 * On-disk layout of each .enc file: [12-byte IV][16-byte auth tag][ciphertext].
 */

const STORAGE_DIR = resolve(process.cwd(), 'storage')
const IV_LEN = 12
const TAG_LEN = 16

function key(): Buffer {
  const b64 = process.env.STORAGE_KEY
  if (!b64) throw new Error('STORAGE_KEY is not set. See .env.example.')
  const buf = Buffer.from(b64, 'base64')
  if (buf.length !== 32) {
    throw new Error('STORAGE_KEY must decode to exactly 32 bytes (AES-256).')
  }
  return buf
}

/** Encrypts and writes bytes; returns the file_key to persist. `contentType` is recorded. */
export async function storeEncrypted(
  bytes: Buffer,
  meta: { contentType: string },
): Promise<{ fileKey: string }> {
  await mkdir(STORAGE_DIR, { recursive: true })
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  const tag = cipher.getAuthTag()

  const id = randomUUID()
  const fileName = `${id}.enc`
  await writeFile(join(STORAGE_DIR, fileName), Buffer.concat([iv, tag, ciphertext]))
  // The content type is stored alongside as a tiny sidecar so downloads can set it.
  await writeFile(join(STORAGE_DIR, `${id}.type`), meta.contentType, 'utf8')
  return { fileKey: fileName }
}

/** Reads and decrypts a stored file. Callers MUST permission-check before invoking. */
export async function readDecrypted(
  fileKey: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  // Guard against path traversal — file_key is an opaque name we generated.
  if (!/^[a-f0-9-]+\.enc$/.test(fileKey)) {
    throw new Error('Invalid file key')
  }
  const raw = await readFile(join(STORAGE_DIR, fileKey))
  const iv = raw.subarray(0, IV_LEN)
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  let contentType = 'application/octet-stream'
  try {
    contentType = await readFile(join(STORAGE_DIR, fileKey.replace(/\.enc$/, '.type')), 'utf8')
  } catch {
    // Missing sidecar → fall back to the generic type.
  }
  return { bytes, contentType }
}
