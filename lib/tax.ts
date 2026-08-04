import 'server-only'

/**
 * GST rates by bill section, and the one rule worth stating twice: the hotel **shows** 18%
 * and **collects none of it** (client's lead, 4 Aug 2026). The only tax that is money —
 * that enters a threshold, a balance, or a receipt — is the 5% on rooms.
 *
 * So every section here is really two different numbers:
 *
 *   rooms                5%, printed AND collected. In the 25% advance base, in the balance.
 *   venue / food /       18%, printed and nothing else. It inflates the "Total" on the
 *   maintenance          document and touches no other figure in the system.
 *
 * That split is why `isCollectedSection` exists rather than a bare sum over line taxes. If
 * the 18% were folded into the payable amount, `balance = payable − paid` would never reach
 * zero and no booking could ever be settled or closed.
 *
 * `adjustment` stays at 0 because the Auditor names a rate per line (FR-7.4) — the default
 * is only what applies when they name none. Their lines are not collected either way.
 *
 * Recorded in docs/SEED_ASSUMPTIONS.md §F8: a GST line on a guest-facing document for tax
 * that is not charged is a question for the hotel's CA, not for this file. It is implemented
 * as instructed and is a one-constant change if that answer comes back different.
 */

/** Basis points. 1800 = 18%, 500 = 5%. */
export const GST_BP: Record<string, number> = {
  venue: 1800,
  food: 1800,
  rooms: 500,
  maintenance: 1800,
  adjustment: 0,
}

/** The 5% on rooms — the only tax the hotel actually takes. */
export const ROOM_GST_BP = 500
/** The 18% shown on everything else. */
export const STANDARD_GST_BP = 1800

/** Rooms alone carry tax that is collected; every other section's tax is display only. */
export function isCollectedSection(section: string): boolean {
  return section === 'rooms'
}

/**
 * Tax on a line, rounded half-up. Charged PER LINE and summed — the sum of line taxes is
 * the authoritative figure, not a percentage of the sub-total, which can differ by a paisa.
 */
export function taxOf(amountPaise: number, bp: number): number {
  return Math.round((amountPaise * bp) / 10000)
}
