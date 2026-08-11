import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Encrypted-at-rest document storage for KYC/Aadhaar (CLAUDE.md rule 7).
 *
 * Bytes are AES-256-GCM encrypted with STORAGE_KEY *before* they leave this process, and
 * only an opaque `file_key` is kept in `guest_documents`. NEVER log document bytes or
 * Aadhaar data.
 *
 * Two drivers behind one interface, chosen by whether a bucket is configured:
 *
 *   GCS_BUCKET set  ->  Google Cloud Storage, private bucket
 *   unset           ->  the local `storage/` directory
 *
 * The local driver is not a deployment option, it is the dev convenience. Cloud Run's
 * filesystem lives in the instance's memory and dies with it, so deployed without a bucket
 * the local driver would accept an Aadhaar upload, report success, and lose the file on the
 * next revision or restart. Since confirming an event requires both Aadhaar sides on record,
 * that failure would surface as "no booking can ever be confirmed", a long way from its cause.
 *
 * Encryption is kept even though the bucket is private. The key never leaves the server, so a
 * leaked URL, a misconfigured bucket or a snapshot of it yields ciphertext and nothing else.
 *
 * Two envelope formats, told apart by the shape of the file_key — a bucket key has a slash:
 *
 *   local   `<uuid>.enc`             [12 IV][16 tag][ciphertext], content type in a sidecar
 *   bucket  `documents/<uuid>.enc`   [12 IV][16 tag][ciphertext of [2-byte len][type][bytes]]
 *
 * The bucket envelope carries its own content type — a second round trip for a sidecar would
 * be wasteful, and encrypting the type leaks marginally less. The local format is untouched
 * so files written before this change still read back.
 */

const STORAGE_DIR = resolve(process.cwd(), 'storage')
const DOC_PREFIX = 'documents/'
const IV_LEN = 12
const TAG_LEN = 16

/** Is a bucket configured? */
const usingBucket = () => Boolean(process.env.GCS_BUCKET)

/**
 * The bucket handle, built once.
 *
 * No credentials are passed: on Cloud Run the client picks up the service account from the
 * metadata server (ADC), so there is no key file to ship in the image or rotate. The import
 * is dynamic so a laptop running the local driver never loads the SDK at all.
 */
let bucketHandle: Awaited<ReturnType<typeof openBucket>> | undefined
async function openBucket() {
  const { Storage } = await import('@google-cloud/storage')
  return new Storage().bucket(process.env.GCS_BUCKET as string)
}
async function bucket() {
  bucketHandle ??= await openBucket()
  return bucketHandle
}

/**
 * Refuses to write to a filesystem that will forget.
 *
 * The local driver is correct on a laptop and catastrophic on a serverless host, and the
 * difference is invisible at the call site — the upload succeeds either way. Deployed
 * without a bucket, the file is gone by the next restart, and because confirming an event
 * requires both Aadhaar sides on record the symptom appears as "nothing can be confirmed",
 * nowhere near the cause. Better to fail at the upload, loudly, naming the fix.
 *
 * `K_SERVICE` is set by Cloud Run, `VERCEL` by Vercel. Both are hosts whose disk is
 * ephemeral. A plain container with a durable volume mounted at ./storage sets neither and
 * is still allowed to use the local driver, as the Dockerfile documents.
 */
function assertPersistent(): void {
  if (usingBucket()) return
  if (process.env.K_SERVICE || process.env.VERCEL) {
    throw new Error(
      'No bucket is configured, so an uploaded document would be written to a filesystem ' +
        'that does not survive the instance. Set GCS_BUCKET to the Cloud Storage bucket ' +
        'holding guest documents.',
    )
  }
}

function key(): Buffer {
  const b64 = process.env.STORAGE_KEY
  if (!b64) throw new Error('STORAGE_KEY is not set. See .env.example.')
  const buf = Buffer.from(b64, 'base64')
  if (buf.length !== 32) {
    throw new Error('STORAGE_KEY must decode to exactly 32 bytes (AES-256).')
  }
  return buf
}

function encrypt(plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

function decrypt(envelope: Buffer): Buffer {
  const iv = envelope.subarray(0, IV_LEN)
  const tag = envelope.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = envelope.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** [2-byte big-endian length][contentType utf8][bytes] — encrypted as one plaintext. */
function pack(bytes: Buffer, contentType: string): Buffer {
  const type = Buffer.from(contentType || 'application/octet-stream', 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(type.byteLength)
  return Buffer.concat([len, type, bytes])
}

function unpack(plaintext: Buffer): { bytes: Buffer; contentType: string } {
  const len = plaintext.readUInt16BE(0)
  const contentType = plaintext.subarray(2, 2 + len).toString('utf8')
  return { bytes: plaintext.subarray(2 + len), contentType }
}

/** Encrypts and stores bytes; returns the file_key to persist against the document row. */
export async function storeEncrypted(
  bytes: Buffer,
  meta: { contentType: string },
): Promise<{ fileKey: string }> {
  assertPersistent()
  const id = randomUUID()

  if (usingBucket()) {
    const pathname = `${DOC_PREFIX}${id}.enc`
    await (await bucket()).file(pathname).save(encrypt(pack(bytes, meta.contentType)), {
      // The object holds ciphertext, so its own content type is exactly what it is. The real
      // one travels inside the envelope.
      contentType: 'application/octet-stream',
      // Documents are a few MB at most; a resumable session would be two extra round trips
      // to protect an upload that either succeeds or is retried by the user anyway.
      resumable: false,
    })
    return { fileKey: pathname }
  }

  await mkdir(STORAGE_DIR, { recursive: true })
  const fileName = `${id}.enc`
  await writeFile(join(STORAGE_DIR, fileName), encrypt(bytes))
  // The content type is stored alongside as a tiny sidecar so downloads can set it.
  await writeFile(join(STORAGE_DIR, `${id}.type`), meta.contentType, 'utf8')
  return { fileKey: fileName }
}

/** Reads and decrypts a stored file. Callers MUST permission-check before invoking. */
export async function readDecrypted(
  fileKey: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  // A bucket key carries its prefix; a local one is a bare file name. The shape is what
  // decides the driver, so a database written under one still reads under the other.
  if (fileKey.startsWith(DOC_PREFIX)) {
    if (!/^documents\/[a-f0-9-]+\.enc$/.test(fileKey)) throw new Error('Invalid file key')
    const [contents] = await (await bucket()).file(fileKey).download()
    return unpack(decrypt(contents))
  }

  // Guard against path traversal — file_key is an opaque name we generated.
  if (!/^[a-f0-9-]+\.enc$/.test(fileKey)) {
    throw new Error('Invalid file key')
  }
  const bytes = decrypt(await readFile(join(STORAGE_DIR, fileKey)))

  let contentType = 'application/octet-stream'
  try {
    contentType = await readFile(join(STORAGE_DIR, fileKey.replace(/\.enc$/, '.type')), 'utf8')
  } catch {
    // Missing sidecar → fall back to the generic type.
  }
  return { bytes, contentType }
}

/**
 * Removes a stored document. Used when a document of the same kind replaces an earlier one:
 * an Aadhaar image nobody can reach is still an Aadhaar image sitting in a bucket, and rule
 * 7 is about what exists at rest, not only about what the app will hand back.
 *
 * Deliberately forgiving — a missing file is the desired end state, and a tidy-up failure
 * must never fail the upload that triggered it.
 */
export async function deleteStored(fileKey: string): Promise<void> {
  try {
    if (fileKey.startsWith(DOC_PREFIX)) {
      await (await bucket()).file(fileKey).delete({ ignoreNotFound: true })
      return
    }
    const { rm } = await import('node:fs/promises')
    await rm(join(STORAGE_DIR, fileKey), { force: true })
    await rm(join(STORAGE_DIR, fileKey.replace(/\.enc$/, '.type')), { force: true })
  } catch {
    // Left behind rather than crashing the request; nothing downstream depends on it.
  }
}
