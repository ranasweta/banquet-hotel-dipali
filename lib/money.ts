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

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

/** 0–99 in words. */
function underHundred(n: number): string {
  if (n < 20) return ONES[n]!
  const t = TENS[Math.floor(n / 10)]!
  const o = n % 10
  return o ? `${t} ${ONES[o]}` : t
}

/** 0–999 in words. */
function underThousand(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  if (!h) return underHundred(rest)
  return rest ? `${ONES[h]} Hundred ${underHundred(rest)}` : `${ONES[h]} Hundred`
}

/**
 * A whole number in Indian-system words — crore, lakh, thousand, hundred. Used for the
 * proposal's "Rupees … Only" line, which a guest signs against, so it groups the way an
 * Indian cheque does rather than in millions.
 */
export function numberToIndianWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`numberToIndianWords: expected a non-negative integer, got ${n}`)
  }
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 10_000_000)
  let rest = n % 10_000_000
  const lakh = Math.floor(rest / 100_000)
  rest %= 100_000
  const thousand = Math.floor(rest / 1_000)
  rest %= 1_000
  if (crore) parts.push(`${numberToIndianWords(crore)} Crore`)
  if (lakh) parts.push(`${underThousand(lakh)} Lakh`)
  if (thousand) parts.push(`${underThousand(thousand)} Thousand`)
  if (rest) parts.push(underThousand(rest))
  return parts.join(' ')
}

/**
 * Splits paise into the rupee and paise words the proposal prints as
 * "Rupees {rupees} and {paise} Paise Only."
 */
export function paiseToWords(paise: Paise): { rupees: string; paise: string } {
  assertPaise(paise)
  const abs = Math.abs(paise)
  return {
    rupees: numberToIndianWords(Math.floor(abs / PAISE_PER_RUPEE)),
    paise: numberToIndianWords(abs % PAISE_PER_RUPEE),
  }
}

export function assertPaise(value: unknown): asserts value is Paise {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`Money must be an integer number of paise, got ${JSON.stringify(value)}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Paise value ${value} exceeds the safe integer range`)
  }
}
