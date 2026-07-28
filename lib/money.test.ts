import { describe, expect, it } from 'vitest'
import {
  assertPaise,
  formatPaise,
  numberToIndianWords,
  paiseToRupees,
  paiseToWords,
  percentOfPaise,
  rupeesToPaise,
} from './money'

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

describe('numberToIndianWords', () => {
  it('groups in lakh and crore, not millions — the proposal is signed in India', () => {
    expect(numberToIndianWords(0)).toBe('Zero')
    expect(numberToIndianWords(7)).toBe('Seven')
    expect(numberToIndianWords(19)).toBe('Nineteen')
    expect(numberToIndianWords(20)).toBe('Twenty')
    expect(numberToIndianWords(45)).toBe('Forty Five')
    expect(numberToIndianWords(100)).toBe('One Hundred')
    expect(numberToIndianWords(101)).toBe('One Hundred One')
    expect(numberToIndianWords(1_000)).toBe('One Thousand')
    expect(numberToIndianWords(15_100)).toBe('Fifteen Thousand One Hundred')
    expect(numberToIndianWords(1_51_000)).toBe('One Lakh Fifty One Thousand')
    expect(numberToIndianWords(1_00_00_000)).toBe('One Crore')
    expect(numberToIndianWords(12_34_56_789)).toBe(
      'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine',
    )
  })

  it('refuses anything that is not a whole non-negative number', () => {
    expect(() => numberToIndianWords(-1)).toThrow(RangeError)
    expect(() => numberToIndianWords(1.5)).toThrow(RangeError)
  })
})

describe('paiseToWords', () => {
  it('splits into the rupee and paise halves the proposal prints', () => {
    // "Rupees Ninety Three Thousand Five Hundred and Zero Paise Only."
    expect(paiseToWords(93_50_000)).toEqual({ rupees: 'Ninety Three Thousand Five Hundred', paise: 'Zero' })
    expect(paiseToWords(65_050)).toEqual({ rupees: 'Six Hundred Fifty', paise: 'Fifty' })
    expect(paiseToWords(0)).toEqual({ rupees: 'Zero', paise: 'Zero' })
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
