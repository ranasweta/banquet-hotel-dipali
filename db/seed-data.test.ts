import { describe, expect, it } from 'vitest'
import { loadMenus, loadRegencyRooms, WEDDING_SURCHARGE_PAISE } from './seed-data'
import { rupeesToPaise } from '../lib/money'

describe('menus.seed.json', () => {
  // Every structural rule (pick <= item count, no duplicate names, wedding = base + 50,
  // all-included implies not free-increase-eligible) is enforced by the zod schema,
  // so a violation anywhere in the file throws here.
  const menus = loadMenus()

  it('loads and validates', () => {
    expect(menus.tiers).toHaveLength(8)
  })

  it('carries the tier rates printed on both cards (PRD §5.3 FR-3.8)', () => {
    const rates = Object.fromEntries(
      menus.tiers.map((t) => [t.name, [t.baseRatePaise, t.weddingRatePaise]]),
    )
    expect(rates).toEqual({
      Silver: [rupeesToPaise(650), rupeesToPaise(700)],
      Gold: [rupeesToPaise(750), rupeesToPaise(800)],
      Platinum: [rupeesToPaise(850), rupeesToPaise(900)],
      Diamond: [rupeesToPaise(950), rupeesToPaise(1000)],
      Crown: [rupeesToPaise(1250), rupeesToPaise(1300)],
      'Breakfast Gold': [rupeesToPaise(400), rupeesToPaise(450)],
      'Breakfast Platinum': [rupeesToPaise(500), rupeesToPaise(550)],
      'High Tea Silver': [rupeesToPaise(300), rupeesToPaise(350)],
    })
  })

  it('applies the Rs. 50 wedding surcharge uniformly, breakfast and high tea included', () => {
    for (const t of menus.tiers) {
      expect(t.weddingRatePaise - t.baseRatePaise, t.name).toBe(WEDDING_SURCHARGE_PAISE)
    }
    expect(WEDDING_SURCHARGE_PAISE).toBe(rupeesToPaise(50))
  })

  it("matches FR-3.1's worked example (Platinum: welcome drink any 3, starters any 4)", () => {
    const platinum = menus.tiers.find((t) => t.name === 'Platinum')!
    const pick = (name: string) => platinum.categories.find((c) => c.name === name)?.pick
    expect(pick('Welcome Drink')).toBe(3)
    expect(pick('Veg Appetizer')).toBe(4)
  })

  it('marks only the BR-M2 categories free-increase eligible', () => {
    const eligible = new Set(
      menus.tiers.flatMap((t) =>
        t.categories.filter((c) => c.freeIncreaseEligible).map((c) => c.name),
      ),
    )
    expect([...eligible].sort()).toEqual([
      'Salad',
      'Soup',
      'Veg Appetizer',
      'Veg Main Course',
      'Veg Starters',
    ])
  })

  it('excludes paneer main course from the free increase (BR-M3 sends it to the GM)', () => {
    for (const t of menus.tiers) {
      const paneer = t.categories.find((c) => c.name === 'Paneer Main Course')
      if (paneer) expect(paneer.freeIncreaseEligible, t.name).toBe(false)
    }
  })

  it('leaves the free salad increase available only on Silver and Gold', () => {
    // Platinum/Diamond/Crown print "SALAD BAR" with no (ANY N) — all-included, so
    // there is nothing to increase. Recorded so the M4 picker is not surprised.
    const withSaladPick = menus.tiers
      .filter((t) => t.categories.some((c) => c.name === 'Salad' && c.freeIncreaseEligible))
      .map((t) => t.name)
    expect(withSaladPick).toEqual(['Silver', 'Gold'])

    const saladBarTiers = menus.tiers
      .filter((t) => t.categories.some((c) => c.name === 'Salad Bar'))
      .map((t) => t.name)
    expect(saladBarTiers).toEqual(['Platinum', 'Diamond', 'Crown'])
  })

  it('treats the unpriced-choice categories as all-included', () => {
    const allIncluded = new Set(
      menus.tiers.flatMap((t) => t.categories.filter((c) => c.pick === null).map((c) => c.name)),
    )
    expect([...allIncluded].sort()).toEqual([
      'Accompaniments',
      'Assorted Indian Bread',
      'Breakfast',
      'High Tea',
      'Salad Bar',
    ])
  })

  it('keeps slash-separated dishes as one item', () => {
    const silver = menus.tiers.find((t) => t.name === 'Silver')!
    const paneer = silver.categories.find((c) => c.name === 'Paneer Main Course')!
    expect(paneer.items).toContain('Paneer Makhani / Handi Paneer')
    expect(paneer.items).toHaveLength(4)
  })

  it('splits the Crown counters so their any-3 picks are satisfiable', () => {
    const crown = menus.tiers.find((t) => t.name === 'Crown')!
    for (const name of ['Pickle Counter', 'Chutney Counter', 'Papad Counter']) {
      const c = crown.categories.find((x) => x.name === name)!
      expect(c.pick, name).toBe(3)
      expect(c.items.length, name).toBeGreaterThanOrEqual(3)
    }
  })

  it('has no category whose pick can never be satisfied', () => {
    // The Diamond live counter prints "(ANY FIVE)" over 4 items; seeded as 4 pending
    // the client. If anyone restores the printed 5 this fails rather than shipping a
    // menu that can never complete and so can never pass the lock checklist.
    for (const t of menus.tiers) {
      for (const c of t.categories) {
        if (c.pick !== null) {
          expect(c.pick, `${t.name} / ${c.name}`).toBeLessThanOrEqual(c.items.length)
        }
      }
    }
  })
})

describe('rooms.regency.seed.json', () => {
  const regency = loadRegencyRooms()

  it('lists exactly the 49 guest rooms the PRD specifies', () => {
    const guestRooms = regency.rooms.filter((r) => r.roomType !== 'dormitory')
    expect(guestRooms).toHaveLength(49)
    expect(regency.totalRooms).toBe(49)
  })

  it('uses only blocks A, B and C', () => {
    expect([...new Set(regency.rooms.map((r) => r.block))].sort()).toEqual(['A', 'B', 'C'])
  })

  it('carries the real rack rates from PRD §3.3', () => {
    const rateFor = (type: string) => regency.rooms.find((r) => r.roomType === type)?.rackRatePaise
    expect(rateFor('deluxe')).toBe(rupeesToPaise(4500))
    expect(rateFor('semi_suite')).toBe(rupeesToPaise(6000))
    expect(rateFor('suite')).toBe(rupeesToPaise(7000))
    expect(rateFor('dormitory')).toBe(rupeesToPaise(50_000))
  })

  it('models the 30-bed dormitory as one bookable unit', () => {
    const dorms = regency.rooms.filter((r) => r.roomType === 'dormitory')
    expect(dorms).toHaveLength(1)
    expect(dorms[0]!.beds).toBe(30)
  })
})
