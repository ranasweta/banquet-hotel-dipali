-- ============================================================
-- 0022 · Real Terms & Conditions text (client PDF, 25 Jul 2026)
-- ============================================================
-- The settings row carried a PLACEHOLDER until the client supplied its "Terms and Conditions
-- for Banquet Booking". The proposal now prints these 25 clauses as a styled annexure driven
-- by lib/terms.ts; this flat copy is the record of terms in force when a bill is drafted
-- (FR-7.6). Only replaced while it is still the placeholder, so an Admin edit is never clobbered.
UPDATE settings
   SET value = $tnc$Terms and Conditions for Banquet Booking

These Terms and Conditions shall form an integral part of the banquet quotation and booking confirmation issued by the Hotel.

1. Booking Confirmation
The booking shall be confirmed only after written acceptance of the quotation and payment of 25% advance of the final quotation amount. Tentative or verbal bookings may be released if the advance is not received within the prescribed period.

2. Payment Terms
The balance amount shall be paid in full at least 30 days before the event. Additional charges incurred during the event shall be paid before final checkout. Cheque payments shall be subject to realisation.

3. Guaranteed Guests
Billing shall be based on the number of guests confirmed in the final quotation or the actual number served, whichever is higher. Reduction in the confirmed guest count shall not be permitted after final confirmation.

4. Food and Beverages
Food and beverages shall be supplied exclusively by the Hotel. Outside food, beverages, packaged water, liquor or catering material shall not be permitted without written approval. Any permitted outside item may attract applicable corkage, handling or service charges. Leftover food shall not be packed or handed over.

5. Liquor Service
Liquor shall be served strictly as per applicable excise laws and Hotel policy. Liquor shall not be served to underage, intoxicated or disorderly persons. Outside liquor is strictly prohibited.

6. Pre-Service Verification and Acceptance
The Client or its authorised representative shall inspect and taste the food items and verify the agreed arrangements before service begins. Once the food has been served or the event arrangements have commenced, no request for change, complaint or grievance regarding the approved items or arrangements shall be accepted.

7. Event Timings
The event shall be conducted within the timings mentioned in the quotation. Any extension shall be subject to availability, prior approval and additional charges. Music, liquor and food service shall stop within legally permitted timings.

8. Hall and Seating Arrangements
Hall allocation, seating, stage and buffet layout shall be finalised in consultation with the Hotel. Major changes after finalisation may attract additional charges. The Hotel reserves the right to shift the event to a similar venue due to operational or unavoidable circumstances.

9. Decoration and Vendors
Decoration, lighting, stage, sound, LED, DJ and entertainment shall be charged separately unless included in the quotation. Outside vendors require prior approval and payment of applicable maintenance charges. Nailing, drilling, stapling, pasting or damaging any kind of hotel property is prohibited. Fireworks, inflammable material, open flames, smoke machines, confetti and colour powder shall not be used without approval. The Client shall be responsible for damage caused by guests, vendors, decorators or invitees.

10. Music and Entertainment
DJ, live music and performances require prior approval. All necessary licences and permissions shall be obtained by the Client. Sound levels must comply with applicable laws and Hotel guidelines. The Hotel may reduce or stop music in case of complaints or legal restrictions.

11. Electricity and Equipment
Additional power load, generator, special lighting or heavy equipment shall be charged separately. The Hotel shall not be responsible for damage caused by voltage fluctuation, improper installation or mishandling.

12. Parking
Parking and valet services shall be subject to availability. Vehicles and valuables kept inside them shall remain at the owner's risk.

13. Guest Conduct and Security
The Client shall ensure proper conduct of guests and vendors. The Hotel may remove any person involved in violence, misconduct, illegal activity, harassment or damage to property. Weapons, narcotics and prohibited activities are strictly prohibited.

14. Loss or Damage
The Client shall compensate the Hotel for any loss, breakage or damage caused by guests, vendors or invitees. The Hotel shall not be responsible for loss or theft of cash, jewellery, gifts, equipment or personal belongings.

15. Cancellation and Postponement
Cancellation or postponement of the confirmed booking shall not be permitted. All amounts paid shall be non-refundable.

16. Force Majeure
The Hotel shall not be liable for delay or failure caused by natural disasters, fire, flood, government restrictions, epidemic, strike, riot, power failure, transport disruption or any event beyond its reasonable control.

17. Accommodation
Guest rooms shall be booked separately and shall be subject to availability and applicable room policies. Banquet booking does not guarantee room availability. Guest-related room damages or unpaid charges shall be recovered from the Client.

18. Photography and Drones
Drone photography shall be permitted only after submission of all required statutory permissions. The Client shall obtain necessary consent from guests for photography and videography.

19. Children
Children shall remain under the supervision of parents or guardians. The Hotel shall not be responsible for injury caused due to lack of supervision. Entry into kitchens, service areas, rooftops and other restricted areas is prohibited.

20. Legal Compliance, Licences and Statutory Permissions
The Client shall, at its own cost and responsibility, comply with all applicable laws and obtain all licences, permissions, approvals and NOCs required for the event, including police, excise, fire safety, noise and other statutory permissions. The Hotel shall not be responsible for obtaining the same. Any penalty, fee, fine, challan, loss or legal consequence arising from non-obtainment or non-compliance shall be borne exclusively by the Client.

21. Right to Stop the Event
The Hotel may suspend or terminate the event without refund in case of safety risk, illegal activity, violent conduct, non-payment, violation of statutory instructions or material change in the disclosed nature of the event.

22. Hotel Liability
The Hotel's liability, if any, shall be limited to the amount actually paid for banquet services. The Hotel shall not be liable for indirect losses or for failure of services provided by vendors appointed directly by the Client.

23. Final Billing
Final billing shall include the confirmed package, additional guests, food and beverages, overtime, breakage, decoration, equipment, power, vendor and licence charges, and any kind of fees, charges and penalties. The Client or authorised representative shall verify and sign the final bill before departure. Any discrepancy must be reported within three days of the invoice.

24. Jurisdiction
Disputes shall first be resolved through mutual discussion. Unresolved disputes shall be subject to the jurisdiction of courts at Sagar, Madhya Pradesh, and governed by Indian law.

25. Acceptance
Payment of advance, written acceptance of the quotation or use of the banquet facility shall constitute acceptance of these Terms and Conditions.

I/We confirm that I/we have read, understood and accepted the quotation and the above Terms and Conditions.$tnc$
 WHERE key = 'terms_and_conditions'
   AND value LIKE 'PLACEHOLDER%';
