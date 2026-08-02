/**
 * Menu-increase payload normalisation — the parsing half of the bug behind
 * "This request carries no increments to apply."
 *
 * Live data holds two shapes, written by different versions of the app, and `applyDeferred`
 * understood only the newer one. These assertions need no database: the defect was entirely in
 * reading the JSON, so it is pinned here where it can be checked in a second rather than in an
 * integration test that depends on a remote Postgres being reachable.
 */
import { describe, expect, it } from 'vitest'
import { normalizeIncrease, summarizeException } from '@/lib/approvals'

/** The shape written since 21 Jul 2026: menuId at the top, a delta, and the dish names. */
const CURRENT = {
  menuId: 'menu-1',
  subEventName: 'Reception',
  items: [
    { categoryName: 'Soup', requesting: 2, dishes: ['Veg Manchow', 'Tom Yam'] },
    { categoryName: 'Rice', requesting: 1, dishes: ['Steam Rice'] },
  ],
}

/** The earlier shape: menuId per item, before → after, and no dish names at all. */
const EARLIER = {
  items: [
    {
      menuId: 'menu-9',
      subEventId: 'sub-9',
      subEventName: 'Haldi',
      categoryName: 'Paneer Main Course',
      currentPick: 1,
      requestedPick: 2,
      reason: 'category_not_free_eligible',
    },
  ],
}

describe('normalizeIncrease', () => {
  it('reads the current shape unchanged', () => {
    const { subEventName, items } = normalizeIncrease(CURRENT)
    expect(subEventName).toBe('Reception')
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ menuId: 'menu-1', categoryName: 'Soup', requesting: 2, dishes: ['Veg Manchow', 'Tom Yam'] })
  })

  it('reads the earlier shape, deriving the delta and the per-item menuId', () => {
    const { subEventName, items } = normalizeIncrease(EARLIER)
    // The name lives inside the item on this shape, not at the top.
    expect(subEventName).toBe('Haldi')
    expect(items).toHaveLength(1)
    expect(items[0]!.menuId).toBe('menu-9')
    // requestedPick 2 − currentPick 1.
    expect(items[0]!.requesting).toBe(1)
    // Truthful: this request genuinely does not know which dishes it is about, and callers
    // must therefore not delete any. Guessing is the bug the newer shape exists to prevent.
    expect(items[0]!.dishes).toEqual([])
  })

  it('drops items that ask for nothing, rather than emitting a zero increment', () => {
    const { items } = normalizeIncrease({
      items: [
        { menuId: 'm', categoryName: 'Soup', currentPick: 2, requestedPick: 2 }, // no change
        { menuId: 'm', categoryName: 'Rice', currentPick: 3, requestedPick: 1 }, // negative
        { menuId: 'm', categoryName: 'Dessert', currentPick: 1, requestedPick: 3 }, // +2
      ],
    })
    expect(items.map((i) => [i.categoryName, i.requesting])).toEqual([['Dessert', 2]])
  })

  it('drops items with no menuId to attach to', () => {
    expect(normalizeIncrease({ items: [{ categoryName: 'Soup', requesting: 1 }] }).items).toEqual([])
  })

  it('survives an empty or malformed payload instead of throwing', () => {
    expect(normalizeIncrease({}).items).toEqual([])
    expect(normalizeIncrease({ items: [] }).items).toEqual([])
    expect(normalizeIncrease({ items: [{}] }).items).toEqual([])
  })
})

describe('summarizeException — what the GM actually reads', () => {
  it('names the segment and the dishes on the current shape', () => {
    expect(summarizeException('menu_increase', CURRENT)).toBe(
      'Reception · Soup +2 — Veg Manchow, Tom Yam; Rice +1 — Steam Rice',
    )
  })

  it('reads as a sentence on the earlier shape, not "+undefined"', () => {
    // The regression this pins: the old reader looked for a top-level subEventName and an
    // `items[].requesting` that this shape has never carried, and printed
    // "Function · Paneer Main Course +undefined" beside a decision worth thousands of rupees.
    const s = summarizeException('menu_increase', EARLIER)
    expect(s).toBe('Haldi · Paneer Main Course +1')
    expect(s).not.toContain('undefined')
  })

  it('says something legible when the request names nothing', () => {
    expect(summarizeException('menu_increase', { items: [] })).toBe('menu increase')
  })
})
