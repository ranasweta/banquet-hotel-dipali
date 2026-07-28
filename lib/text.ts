/**
 * Presentation helpers shared by the guest-facing documents. Deliberately NOT server-only:
 * the proposal renders in the browser.
 */

/**
 * Names as a guest should read them: "sahil narang" prints as Sahil Narang, "mehandi" as
 * Mehandi. Booking staff type at speed, and a document that prints exactly what was typed
 * reads as careless — this is the document's manners, not the database's, so nothing is
 * rewritten at rest.
 *
 * Deliberate capitals survive. "LED", "DJ" and "McDonald" keep their shape, because a word
 * that already carries a capital was written that way on purpose. The one exception is a
 * field shouted entirely in capitals — there the shout is the accident, so it is undone.
 * Underscores (room_type's `semi_suite`) become spaces on the way through, and letters
 * after a hyphen or apostrophe capitalise too, so "d'souza" and "sita-ram" come out right.
 */
export function titleCase(input: string): string {
  const s = input.replace(/[_\s]+/g, ' ').trim()
  if (!s) return s
  const shouted = s === s.toUpperCase() && /[A-Z]{2}/.test(s)
  return s
    .split(' ')
    .map((w) => {
      if (!shouted && w !== w.toLowerCase()) return w
      return w.toLowerCase().replace(/(^|[-'’.])([a-z])/g, (_, lead: string, c: string) => lead + c.toUpperCase())
    })
    .join(' ')
}

/** "1 function" but "2 functions" — a plural that disagrees reads like an unfinished form. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The rooms · room-nights pair, which the proposal repeats in five places. */
export const roomsAndNights = (rooms: number, nights: number, nightWord = 'room-night') =>
  `${plural(rooms, 'room')} · ${plural(nights, nightWord)}`
