/**
 * Terms & Conditions for Banquet Booking — the two-page annexure that accompanies every
 * proposal (client PDF, "DRAFT - TERMS AND CONDITIONS FOR BANQUET BOOKING"). Transcribed here
 * so the proposal can print the clauses as styled pages after the estimate rather than pasting
 * a flat blob. The plain-text rendering (`termsPlainText`) is what the settings snapshot holds,
 * so the record of "terms in force" (FR-7.6) stays a single source of truth with this file.
 */

export const HOTEL = {
  name: 'Hotel Dipali Sagar',
  address: 'Near Makroniya Railway Crossing, Jabalpur Road, Sagar, Madhya Pradesh 470004',
  phone: '+91 07582 263910 · 9109993582',
  email: 'hoteldeepalisagar@gmail.com',
  gstin: '23AAQFH9964C1Z2',
  fssai: '11424470000084',
} as const

export const TERMS_TITLE = 'Terms and Conditions for Banquet Booking'
export const TERMS_INTRO =
  'These Terms and Conditions shall form an integral part of the banquet quotation and booking confirmation issued by the Hotel.'

export type TermClause = { title: string; body: string }

export const TERMS_CLAUSES: TermClause[] = [
  {
    title: 'Booking Confirmation',
    body: 'The booking shall be confirmed only after written acceptance of the quotation and payment of 25% advance of the final quotation amount. Tentative or verbal bookings may be released if the advance is not received within the prescribed period.',
  },
  {
    title: 'Payment Terms',
    body: 'The balance amount shall be paid in full at least 30 days before the event. Additional charges incurred during the event shall be paid before final checkout. Cheque payments shall be subject to realisation.',
  },
  {
    title: 'Guaranteed Guests',
    body: 'Billing shall be based on the number of guests confirmed in the final quotation or the actual number served, whichever is higher. Reduction in the confirmed guest count shall not be permitted after final confirmation.',
  },
  {
    title: 'Food and Beverages',
    body: 'Food and beverages shall be supplied exclusively by the Hotel. Outside food, beverages, packaged water, liquor or catering material shall not be permitted without written approval. Any permitted outside item may attract applicable corkage, handling or service charges. Leftover food shall not be packed or handed over.',
  },
  {
    title: 'Liquor Service',
    body: 'Liquor shall be served strictly as per applicable excise laws and Hotel policy. Liquor shall not be served to underage, intoxicated or disorderly persons. Outside liquor is strictly prohibited.',
  },
  {
    title: 'Pre-Service Verification and Acceptance',
    body: 'The Client or its authorised representative shall inspect and taste the food items and verify the agreed arrangements before service begins. Once the food has been served or the event arrangements have commenced, no request for change, complaint or grievance regarding the approved items or arrangements shall be accepted.',
  },
  {
    title: 'Event Timings',
    body: 'The event shall be conducted within the timings mentioned in the quotation. Any extension shall be subject to availability, prior approval and additional charges. Music, liquor and food service shall stop within legally permitted timings.',
  },
  {
    title: 'Hall and Seating Arrangements',
    body: 'Hall allocation, seating, stage and buffet layout shall be finalised in consultation with the Hotel. Major changes after finalisation may attract additional charges. The Hotel reserves the right to shift the event to a similar venue due to operational or unavoidable circumstances.',
  },
  {
    title: 'Decoration and Vendors',
    body: 'Decoration, lighting, stage, sound, LED, DJ and entertainment shall be charged separately unless included in the quotation. Outside vendors require prior approval and payment of applicable maintenance charges. Nailing, drilling, stapling, pasting or damaging any kind of hotel property is prohibited. Fireworks, inflammable material, open flames, smoke machines, confetti and colour powder shall not be used without approval. The Client shall be responsible for damage caused by guests, vendors, decorators or invitees.',
  },
  {
    title: 'Music and Entertainment',
    body: 'DJ, live music and performances require prior approval. All necessary licences and permissions shall be obtained by the Client. Sound levels must comply with applicable laws and Hotel guidelines. The Hotel may reduce or stop music in case of complaints or legal restrictions.',
  },
  {
    title: 'Electricity and Equipment',
    body: 'Additional power load, generator, special lighting or heavy equipment shall be charged separately. The Hotel shall not be responsible for damage caused by voltage fluctuation, improper installation or mishandling.',
  },
  {
    title: 'Parking',
    body: 'Parking and valet services shall be subject to availability. Vehicles and valuables kept inside them shall remain at the owner’s risk.',
  },
  {
    title: 'Guest Conduct and Security',
    body: 'The Client shall ensure proper conduct of guests and vendors. The Hotel may remove any person involved in violence, misconduct, illegal activity, harassment or damage to property. Weapons, narcotics and prohibited activities are strictly prohibited.',
  },
  {
    title: 'Loss or Damage',
    body: 'The Client shall compensate the Hotel for any loss, breakage or damage caused by guests, vendors or invitees. The Hotel shall not be responsible for loss or theft of cash, jewellery, gifts, equipment or personal belongings.',
  },
  {
    title: 'Cancellation and Postponement',
    body: 'Cancellation or postponement of the confirmed booking shall not be permitted. All amounts paid shall be non-refundable.',
  },
  {
    title: 'Force Majeure',
    body: 'The Hotel shall not be liable for delay or failure caused by natural disasters, fire, flood, government restrictions, epidemic, strike, riot, power failure, transport disruption or any event beyond its reasonable control.',
  },
  {
    title: 'Accommodation',
    body: 'Guest rooms shall be booked separately and shall be subject to availability and applicable room policies. Banquet booking does not guarantee room availability. Guest-related room damages or unpaid charges shall be recovered from the Client.',
  },
  {
    title: 'Photography and Drones',
    body: 'Drone photography shall be permitted only after submission of all required statutory permissions. The Client shall obtain necessary consent from guests for photography and videography.',
  },
  {
    title: 'Children',
    body: 'Children shall remain under the supervision of parents or guardians. The Hotel shall not be responsible for injury caused due to lack of supervision. Entry into kitchens, service areas, rooftops and other restricted areas is prohibited.',
  },
  {
    title: 'Legal Compliance, Licences and Statutory Permissions',
    body: 'The Client shall, at its own cost and responsibility, comply with all applicable laws and obtain all licences, permissions, approvals and NOCs required for the event, including police, excise, fire safety, noise and other statutory permissions. The Hotel shall not be responsible for obtaining the same. Any penalty, fee, fine, challan, loss or legal consequence arising from non-obtainment or non-compliance shall be borne exclusively by the Client.',
  },
  {
    title: 'Right to Stop the Event',
    body: 'The Hotel may suspend or terminate the event without refund in case of safety risk, illegal activity, violent conduct, non-payment, violation of statutory instructions or material change in the disclosed nature of the event.',
  },
  {
    title: 'Hotel Liability',
    body: 'The Hotel’s liability, if any, shall be limited to the amount actually paid for banquet services. The Hotel shall not be liable for indirect losses or for failure of services provided by vendors appointed directly by the Client.',
  },
  {
    title: 'Final Billing',
    body: 'Final billing shall include the confirmed package, additional guests, food and beverages, overtime, breakage, decoration, equipment, power, vendor and licence charges, and any kind of fees, charges and penalties. The Client or authorised representative shall verify and sign the final bill before departure. Any discrepancy must be reported within three days of the invoice.',
  },
  {
    title: 'Jurisdiction',
    body: 'Disputes shall first be resolved through mutual discussion. Unresolved disputes shall be subject to the jurisdiction of courts at Sagar, Madhya Pradesh, and governed by Indian law.',
  },
  {
    title: 'Acceptance',
    body: 'Payment of advance, written acceptance of the quotation or use of the banquet facility shall constitute acceptance of these Terms and Conditions.',
  },
]

export const TERMS_ACCEPTANCE =
  'I/We confirm that I/we have read, understood and accepted the quotation and the above Terms and Conditions.'

/** Flat text for the settings snapshot / record of terms in force (FR-7.6). */
export function termsPlainText(): string {
  const clauses = TERMS_CLAUSES.map((c, i) => `${i + 1}. ${c.title}\n${c.body}`).join('\n\n')
  return `${TERMS_TITLE}\n\n${TERMS_INTRO}\n\n${clauses}\n\n${TERMS_ACCEPTANCE}`
}
