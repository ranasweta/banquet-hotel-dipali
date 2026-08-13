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
 * Lines the separators alone get wrong, written out by hand. A dry run over the hotel's 119
 * combined lines showed every heuristic inventing dishes — a "single-word parts share the
 * trailing noun" rule turned "Rasbhari / Gulab Jamun" into "Rasbhari Jamun" and
 * "Dosa / Bombey Bhel" into "Dosa Bhel", because it cannot tell a modifier ("Veg") from a
 * whole dish ("Rasmalai"). So only lines checked by eye are listed here; everything else
 * splits plainly. Add to this as more are spotted.
 */
const EXPLICIT_SPLITS: Record<string, string[]> = {
  // The koftas share their trailing noun.
  'Veg / Punjabi / Malai / Palak Kofta': ['Veg Kofta', 'Punjabi Kofta', 'Malai Kofta', 'Palak Kofta'],
  // ...and this one shares its leading words, so a plain split would leave a dish called
  // "Masala" on its own.
  'South Indian Dosa Plain, Masala': ['South Indian Dosa Plain', 'South Indian Dosa Masala'],
  // "Two Types" is the count, not a dish. Diamond and Crown spell the same line out as
  // "Missi Roti, Puri, Masala Puri", so Platinum's shorthand is those same two puris — left
  // whole it read as one dish nobody else offered (client, 13 Aug 2026).
  'Puri Two Types': ['Puri', 'Masala Puri'],
  // Shares its trailing noun, like the koftas above: every other tier lists "Aloo Tikki
  // Chaat", and Gold lists "Papdi Chaat" separately in the same breath. The heuristic cannot
  // fire here because "Aloo Tikki" is two words, so it is written out.
  'Aloo Tikki / Papdi Chaat': ['Aloo Tikki Chaat', 'Papdi Chaat'],
}

/** "/", "\" and "," all separate dishes on one printed line. */
const SEPARATORS = new Set(['/', '\\', ','])

/**
 * Splits on the separators, but only at the top level. One inside brackets belongs to the name:
 * "Seasonal Halwa (Gajar / Lauki)" and "Poori Two Types (Plain, Masala)" are each a single
 * dish, and splitting them blindly produced nonsense like "Seasonal Halwa (Gajar" + "Lauki)".
 */
function splitTopLevel(raw: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of raw) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (SEPARATORS.has(ch) && depth === 0) {
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
  const explicit = EXPLICIT_SPLITS[raw.trim()]
  if (explicit) return explicit
  const parts = splitTopLevel(raw)
  return parts.length < 2 ? [raw.trim()] : parts
}
