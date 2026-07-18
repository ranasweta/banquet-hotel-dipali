import 'server-only'
import { inArray } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'

/**
 * Reads configurable business-rule values from the `settings` master (FR-8.2/8.3): the
 * advance percentage, discount caps, the large-allocation threshold, and so on. Values are
 * stored as text; callers ask for the numeric ones through `getIntSettings`.
 */
export async function getIntSettings<K extends string>(
  keys: readonly K[],
  fallbacks: Record<K, number>,
): Promise<Record<K, number>> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys as unknown as string[]))
  const out = { ...fallbacks }
  for (const r of rows) {
    const n = Number(r.value)
    if (Number.isFinite(n)) out[r.key as K] = n
  }
  return out
}
