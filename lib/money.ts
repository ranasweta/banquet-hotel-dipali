/**
 * Money is BIGINT paise everywhere — DB, API, and state (CLAUDE.md rule 1, NFR-5).
 * Rupees exist only at the UI edge. Never use a float for money.
 */

/** A whole number of paise. 100 paise = Rs. 1. */
export type Paise = number

const PAISE_PER_RUPEE = 100

/**
 * Converts rupees to paise. Accepts the fractional rupee values that appear on rate
 * cards; rounds half-up to the nearest paise so 0.1 + 0.2 style float error can never
 * reach the database.
 */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new RangeError(`rupeesToPaise: expected a finite number, got ${rupees}`)
  }
  return Math.round(rupees * PAISE_PER_RUPEE)
}

/**
 * Converts paise to a rupee number. For display and export only — never feed the
 * result back into a calculation that lands in the DB.
 */
export function paiseToRupees(paise: Paise): number {
  assertPaise(paise)
  return paise / PAISE_PER_RUPEE
}

/**
 * Formats paise as Indian-locale rupees, e.g. 15100000 → "₹1,51,000.00".
 * Lakh/crore grouping comes from the en-IN locale.
 */
export function formatPaise(paise: Paise, opts: { symbol?: boolean } = {}): string {
  assertPaise(paise)
  const { symbol = true } = opts
  return new Intl.NumberFormat('en-IN', {
    style: symbol ? 'currency' : 'decimal',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / PAISE_PER_RUPEE)
}

/**
 * Percentage of an amount, in paise, rounded half-up. Used by BR-P1 (advance ≥ 25% of
 * proposal) and BR-D2 (combined discount ≤ 10%). Integer maths throughout.
 */
export function percentOfPaise(paise: Paise, percent: number): Paise {
  assertPaise(paise)
  if (!Number.isFinite(percent)) {
    throw new RangeError(`percentOfPaise: expected a finite percent, got ${percent}`)
  }
  return Math.round((paise * percent) / 100)
}

export function assertPaise(value: unknown): asserts value is Paise {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`Money must be an integer number of paise, got ${JSON.stringify(value)}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Paise value ${value} exceeds the safe integer range`)
  }
}
