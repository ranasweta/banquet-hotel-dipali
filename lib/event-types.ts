/**
 * The event types a booking can actually be made as.
 *
 * The `event_types` table carries six rows, but the proposal has only ever offered **two**:
 * Wedding, and Others. The other four — engagement, mahila sangeet, birthday, corporate —
 * are unreachable, because the booking wizard has always filtered the dropdown down to this
 * pair. A price nobody can ever select is not configuration, it is four extra columns for the
 * Auditor to read past on every venue.
 *
 * Wedding is the one that behaves differently: it takes three contacts, carries the per-plate
 * surcharge (BR-M5), and is the only type that pays a standalone hall charge (client, 12 Aug
 * 2026). Everything else is Others.
 *
 * Kept here rather than in the wizard so the venue master shows exactly the prices a booking
 * can use — same reason `lib/menu-ladder.ts` exists. Deliberately free of server-only imports
 * so the client components can read it too.
 *
 * The four dead rows are LEFT IN the table on purpose: `venue_rate_cards.event_type` and
 * `events.event_type` are foreign keys to it, and dropping rows that old data may reference
 * buys nothing. They are simply never offered.
 */

export const BOOKABLE_EVENT_TYPES = ['wedding', 'other'] as const

export type BookableEventType = (typeof BOOKABLE_EVENT_TYPES)[number]

export function isBookableEventType(code: string): code is BookableEventType {
  return (BOOKABLE_EVENT_TYPES as readonly string[]).includes(code)
}

/**
 * What the guest-facing screens call it. The table says "Other"; every screen says "Others",
 * which is the word the hotel uses.
 */
export function eventTypeLabel(code: string, displayName: string): string {
  return code === 'other' ? 'Others' : displayName
}
