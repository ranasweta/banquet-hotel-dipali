import { describe, expect, it } from 'vitest'
import { plural, roomsAndNights, titleCase } from './text'

describe('titleCase', () => {
  it('lifts what booking staff typed in a hurry', () => {
    // The two the client caught on a printed proposal (28 Jul 2026).
    expect(titleCase('sahil narang')).toBe('Sahil Narang')
    expect(titleCase('mehandi')).toBe('Mehandi')
    expect(titleCase('reception')).toBe('Reception')
  })

  it('undoes a field shouted entirely in capitals', () => {
    expect(titleCase('SAHIL NARANG')).toBe('Sahil Narang')
    expect(titleCase('SANGEET')).toBe('Sangeet')
  })

  it('leaves deliberate capitals alone — an acronym is not a typo', () => {
    // The field is not shouted, so LED and DJ keep their shape while the rest is lifted.
    expect(titleCase('LED wall')).toBe('LED Wall')
    expect(titleCase('DJ and sound')).toBe('DJ And Sound')
    expect(titleCase('McDonald')).toBe('McDonald')
    expect(titleCase('Rajesh & Anita Verma')).toBe('Rajesh & Anita Verma')
  })

  it('capitalises after a hyphen or apostrophe', () => {
    expect(titleCase("d'souza")).toBe("D'Souza")
    expect(titleCase('sita-ram')).toBe('Sita-Ram')
  })

  it('turns an enum into words — room_type reaches the guest as a category', () => {
    expect(titleCase('semi_suite')).toBe('Semi Suite')
    expect(titleCase('presidential_suite')).toBe('Presidential Suite')
    expect(titleCase('deluxe')).toBe('Deluxe')
  })

  it('survives the empty and the untidy', () => {
    expect(titleCase('')).toBe('')
    expect(titleCase('   ')).toBe('')
    expect(titleCase('  sahil   narang  ')).toBe('Sahil Narang')
  })
})

describe('plural', () => {
  it('agrees with its number', () => {
    expect(plural(1, 'function')).toBe('1 function')
    expect(plural(2, 'function')).toBe('2 functions')
    expect(plural(0, 'room')).toBe('0 rooms')
  })

  it('takes an irregular plural when the -s form would be wrong', () => {
    expect(plural(1, 'night', 'nights')).toBe('1 night')
  })
})

describe('roomsAndNights', () => {
  it('reads correctly at one of each', () => {
    expect(roomsAndNights(1, 1)).toBe('1 room · 1 room-night')
    expect(roomsAndNights(30, 80)).toBe('30 rooms · 80 room-nights')
    expect(roomsAndNights(0, 0)).toBe('0 rooms · 0 room-nights')
    expect(roomsAndNights(2, 4, 'night')).toBe('2 rooms · 4 nights')
  })
})
