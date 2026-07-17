/**
 * Loads and validates the isolated seed data files. Validation runs before any DB
 * write so a bad hand-edit fails loudly at the file, not halfway through a seed.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const DB_DIR = resolve(import.meta.dirname)

/** Rs. 50 per plate for weddings (BR-M5), uniform across all eight tiers. */
export const WEDDING_SURCHARGE_PAISE = 5000

const category = z
  .object({
    name: z.string().min(1),
    printedAs: z.string().optional(),
    /** null = every item included; see menu_categories.pick_count. */
    pick: z.number().int().positive().nullable(),
    freeIncreaseEligible: z.boolean(),
    items: z.array(z.string().min(1)).min(1),
  })
  .passthrough()
  .superRefine((c, ctx) => {
    if (c.pick !== null && c.pick > c.items.length) {
      ctx.addIssue({
        code: 'custom',
        message: `pick of ${c.pick} exceeds ${c.items.length} item(s) — the category could never be completed`,
      })
    }
    if (c.pick === null && c.freeIncreaseEligible) {
      ctx.addIssue({
        code: 'custom',
        message: 'an all-included category cannot be free-increase eligible (BR-M2)',
      })
    }
    const dupes = c.items.filter((it, i) => c.items.indexOf(it) !== i)
    if (dupes.length) {
      ctx.addIssue({ code: 'custom', message: `duplicate item(s): ${dupes.join(', ')}` })
    }
  })

const tier = z
  .object({
    name: z.string().min(1),
    printedAs: z.string().optional(),
    baseRatePaise: z.number().int().positive(),
    weddingRatePaise: z.number().int().positive(),
    categories: z.array(category).min(1),
  })
  .passthrough()
  .superRefine((t, ctx) => {
    if (t.weddingRatePaise - t.baseRatePaise !== WEDDING_SURCHARGE_PAISE) {
      ctx.addIssue({
        code: 'custom',
        message: `wedding rate ${t.weddingRatePaise} minus base ${t.baseRatePaise} is not the Rs. 50 surcharge (BR-M5)`,
      })
    }
    const names = t.categories.map((c) => c.name)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    if (dupes.length) {
      // menu_categories has UNIQUE (tier_id, name)
      ctx.addIssue({ code: 'custom', message: `duplicate category name(s): ${dupes.join(', ')}` })
    }
  })

const menusFile = z
  .object({
    effectiveFrom: z.iso.date(),
    weddingSurchargePaise: z.literal(WEDDING_SURCHARGE_PAISE),
    tiers: z.array(tier).min(1),
  })
  .passthrough()

const regencyRoomsFile = z
  .object({
    unit: z.literal('Regency'),
    totalRooms: z.number().int().positive(),
    rooms: z
      .array(
        z.object({
          block: z.string().min(1),
          roomNo: z.string().min(1),
          roomType: z.string().min(1),
          beds: z.number().int().positive(),
          rackRatePaise: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  })
  .passthrough()
  .superRefine((f, ctx) => {
    const guestRooms = f.rooms.filter((r) => r.roomType !== 'dormitory')
    if (guestRooms.length !== f.totalRooms) {
      ctx.addIssue({
        code: 'custom',
        message: `totalRooms says ${f.totalRooms} but ${guestRooms.length} non-dormitory rooms are listed`,
      })
    }
    const keys = f.rooms.map((r) => r.roomNo)
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
    if (dupes.length) {
      // rooms has UNIQUE (unit_id, room_no)
      ctx.addIssue({ code: 'custom', message: `duplicate room number(s): ${dupes.join(', ')}` })
    }
  })

export type MenusSeed = z.infer<typeof menusFile>
export type RegencyRoomsSeed = z.infer<typeof regencyRoomsFile>

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(join(DB_DIR, file), 'utf8'))
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`${file} is invalid:\n${lines.join('\n')}`)
  }
  return result.data
}

export function loadMenus(): MenusSeed {
  return parseOrThrow(menusFile, loadJson('menus.seed.json'), 'db/menus.seed.json')
}

export function loadRegencyRooms(): RegencyRoomsSeed {
  return parseOrThrow(
    regencyRoomsFile,
    loadJson('rooms.regency.seed.json'),
    'db/rooms.regency.seed.json',
  )
}
