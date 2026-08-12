/**
 * The banquet tier ladder, and the segments the hotel's card renames as it climbs.
 *
 * Two screens depend on this being one answer. The menu master cascades a new dish UP the
 * ladder (a richer card contains the poorer ones), and the picker's Swap list pools every
 * tier's dishes for a segment. If they disagreed about what counts as "the same segment", a
 * dish would cascade onto Crown's card and then fail to appear in the Swap list that offers
 * it — so the rule lives here and both import it, as `lib/tax.ts` and `lib/discounts.ts` do
 * for theirs.
 *
 * Deliberately free of server-only imports, like `lib/menu-name.ts`, so nothing stops the
 * picker using it later.
 */

/**
 * The banquet tiers, cheapest first.
 *
 * Hardcoded rather than a `menu_tiers` column because the ladder is the hotel's price list,
 * not something a screen should let anyone re-order: promoting Silver above Crown would
 * silently rewrite what every card contains from then on. It also keeps the meal-time tiers
 * — Breakfast Gold, High Tea Silver — off the ladder, which is right: those are separate
 * cards, not richer ones, and "Breakfast Gold" is above nothing. A tier not named here
 * neither cascades nor receives.
 */
export const TIER_LADDER = ['Silver', 'Gold', 'Platinum', 'Diamond', 'Crown'] as const

/**
 * The same course under two names. The card relabels three segments as it climbs, and
 * matching on name alone stops dead at each boundary — a dish typed into Silver's "Salad"
 * would miss Platinum, Diamond and Crown, which call it "Salad Bar". These are the three,
 * checked against the seeded card (12 Aug 2026):
 *
 *   Salad          → Salad Bar     from Platinum up
 *   Veg Appetizer  → Veg Starters  from Diamond up
 *   Raita          → Raita Bar     at Crown
 *
 * Aliasing rather than renaming the segments: the names are what gets PRINTED on the guest's
 * card, and Crown says "Raita Bar" because a Crown raita is a bar. Equalising the catalog to
 * make the code's life easier would change the product to fit the plumbing.
 *
 * A group is unordered — membership is what matters, not direction — so it holds whichever
 * side a dish is typed into, and whichever side a menu is being picked on.
 */
const SEGMENT_ALIASES: readonly (readonly string[])[] = [
  ['Salad', 'Salad Bar'],
  ['Veg Appetizer', 'Veg Starters'],
  ['Raita', 'Raita Bar'],
]

/** Every name that means the same course as `name`, `name` itself included. */
export function segmentAliases(name: string): string[] {
  const group = SEGMENT_ALIASES.find((g) => g.includes(name))
  return group ? [...group] : [name]
}
