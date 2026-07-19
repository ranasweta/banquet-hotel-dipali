/**
 * A menu line like "Aloo Gobhi Mutter / Chana Masala" lists two distinct dishes — "/" and "\"
 * are separators the hotel uses inside one printed line, not part of a dish name (client
 * instruction, 19 Jul 2026). The picker must offer them as separate choices.
 *
 * One wrinkle: some lines share a trailing noun. "Veg / Punjabi / Malai / Palak Kofta" means
 * four koftas — splitting naively would invent dishes called "Veg" and "Punjabi". So when every
 * part before the last is a single word and the last part has two or more words, the last word
 * is treated as shared and appended to the earlier parts. Lines whose parts are already full
 * names ("Rabdi Jalebi / Rose Barfi") are left alone.
 */
/**
 * Lines where the last word really is shared by every part. Kept as an explicit list, not a
 * heuristic: a dry run over the hotel's 119 combined lines showed a "single-word parts share
 * the trailing noun" rule inventing dishes ("Rasbhari / Gulab Jamun" → "Rasbhari Jamun",
 * "Dosa / Bombey Bhel" → "Dosa Bhel"). It cannot tell a modifier ("Veg") from a whole dish
 * ("Rasmalai"), so only lines verified by eye belong here. Add to it as more are spotted.
 */
const SHARED_TRAILING_NOUN = new Set(['Veg / Punjabi / Malai / Palak Kofta'])

/**
 * Splits on "/" and "\" only at the top level. A separator inside brackets is part of one
 * name — "Seasonal Halwa (Gajar / Lauki)" is a single dish, and splitting it blindly produced
 * the nonsense pair "Seasonal Halwa (Gajar" + "Lauki)".
 */
function splitTopLevel(raw: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of raw) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if ((ch === '/' || ch === '\\') && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

export function splitMenuItemName(raw: string): string[] {
  const parts = splitTopLevel(raw)
  if (parts.length < 2) return [raw.trim()]

  if (SHARED_TRAILING_NOUN.has(raw.trim())) {
    const last = parts[parts.length - 1]!
    const words = last.split(/\s+/)
    const suffix = words[words.length - 1]!
    return [...parts.slice(0, -1).map((p) => `${p} ${suffix}`), last]
  }
  return parts
}
