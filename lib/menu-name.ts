/**
 * Identity of a menu item by name.
 *
 * The hotel's cards spell the same dish differently from tier to tier — "Aam Pana (Seasonal)",
 * "Aam Pana Seasonal", "Aam Panna" and "Aam Panna (Seasonal)" are one drink; so are "Jal Jeera"
 * and "Jaljeera". Compared as raw strings they look like four dishes and two dishes, which is
 * how duplicates leaked into the pooled master menu that Swap offers.
 *
 * menuItemKey() reduces a name to what it actually identifies: lower-cased, bracketed
 * qualifiers and a trailing "seasonal" dropped, punctuation and spacing removed. Spelling
 * variants that survive that (a doubled letter, say) are listed explicitly rather than guessed
 * at with fuzzy matching — merging two genuinely different dishes would be worse than showing
 * one twice. Deliberately free of server-only imports so the picker can use it too.
 */

/** Normalised keys that mean the same dish. Left-hand key folds into the right-hand one. */
const ALIASES: Record<string, string> = {
  aampanna: 'aampana', // "Aam Panna" / "Aam Pana"
  roohafza: 'rooafza',
  ruhafza: 'rooafza',
}

export function menuItemKey(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(Seasonal)", "(Plain, Masala)" — a qualifier, not the name
    .replace(/\bseasonal\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
  return ALIASES[base] ?? base
}

/**
 * Collapses names that identify the same dish, keeping the tidiest spelling of each — the
 * shortest, which drops the "(Seasonal)" and "Two Types" style trailers. Order is preserved
 * so a caller's sort survives.
 */
export function dedupeMenuNames(names: string[]): string[] {
  const best = new Map<string, string>()
  for (const name of names) {
    const key = menuItemKey(name)
    const current = best.get(key)
    if (!current || name.length < current.length) best.set(key, name)
  }
  return [...best.values()]
}
