import { describe, expect, it } from 'vitest'
import { assertPaise, formatPaise, paiseToRupees, percentOfPaise, rupeesToPaise } from './money'

describe('rupeesToPaise', () => {
  it('converts whole rupees', () => {
    expect(rupeesToPaise(650)).toBe(65_000)
    expect(rupeesToPaise(151_000)).toBe(15_100_000)
    expect(rupeesToPaise(0)).toBe(0)
  })

  it('rounds float error away instead of letting it reach the DB', () => {
    // 0.1 + 0.2 = 0.30000000000000004; naive *100 would give 30.000000000000004
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30)
    expect(Number.isInteger(rupeesToPaise(1234.567))).toBe(true)
  })

  it('rejects non-finite input', () => {
    expect(() => rupeesToPaise(Number.NaN)).toThrow(RangeError)
    expect(() => rupeesToPaise(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('paiseToRupees', () => {
  it('round-trips whole rupees', () => {
    expect(paiseToRupees(rupeesToPaise(1250))).toBe(1250)
  })

  it('rejects a non-integer paise value', () => {
    expect(() => paiseToRupees(10.5)).toThrow(TypeError)
  })
})

describe('formatPaise', () => {
  it('groups in the Indian lakh system', () => {
    // Rs. 1,51,000 — the Crystal Hall wedding rate, grouped 1,51 not 151
    expect(formatPaise(15_100_000)).toContain('1,51,000')
    expect(formatPaise(50_000_000)).toContain('5,00,000')
  })

  it('always shows two decimal places', () => {
    expect(formatPaise(65_000, { symbol: false })).toBe('650.00')
    expect(formatPaise(65_050, { symbol: false })).toBe('650.50')
  })
})

describe('percentOfPaise', () => {
  it('computes the BR-P1 25% advance', () => {
    // 25% of Rs. 2,25,000 (Gulmohar + Middle Lawn) = Rs. 56,250
    expect(percentOfPaise(22_500_000, 25)).toBe(5_625_000)
  })

  it('computes the BR-D2 10% discount cap', () => {
    expect(percentOfPaise(15_100_000, 10)).toBe(1_510_000)
  })

  it('rounds to whole paise rather than returning a fraction', () => {
    expect(percentOfPaise(1, 25)).toBe(0)
    expect(percentOfPaise(3, 50)).toBe(2) // 1.5 rounds half-up
    expect(Number.isInteger(percentOfPaise(333_333, 33))).toBe(true)
  })
})

describe('assertPaise', () => {
  it('accepts integers and rejects everything else', () => {
    expect(() => assertPaise(0)).not.toThrow()
    expect(() => assertPaise(65_000)).not.toThrow()
    expect(() => assertPaise(650.5)).toThrow(TypeError)
    expect(() => assertPaise('650')).toThrow(TypeError)
    expect(() => assertPaise(null)).toThrow(TypeError)
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })
})
