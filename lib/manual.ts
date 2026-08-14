/**
 * The in-app user manual, written for the three managers who work the system daily.
 *
 * Content, not code: it is kept here rather than in the component so the wording is one
 * file a non-developer can be pointed at, and so the same text can be printed later without
 * lifting it out of JSX.
 *
 * Every step describes a control that exists TODAY. Where a rule decides what the screen
 * does — the two free extras, the 10% cap, the 18% that is printed and not collected — the
 * rule is stated in the step it governs, because a manual that omits it teaches the counter
 * to charge the wrong figure.
 */

export type ManualStep = {
  title: string
  body: string
  /** A rule or consequence worth setting apart from the instruction. */
  note?: string
  /** Screenshots of the step, under `public/manual/`, in the order they are worked through.
   *  Width and height are each file's own, so the page reserves the right space before the
   *  image loads and the text below it does not jump. */
  images?: { src: string; width: number; height: number; alt: string }[]
}

export type ManualSection = {
  heading: string
  /** Where in the app this section happens, shown as a breadcrumb. */
  where?: string
  steps: ManualStep[]
}

export type RoleGuide = {
  role: string
  label: string
  summary: string
  sections: ManualSection[]
}

const BOOKING_MANAGER: RoleGuide = {
  role: 'booking_manager',
  label: 'Booking Manager',
  summary:
    'You take the enquiry, build the proposal, collect the advance and confirm the dates. Approvals reach the GM on their own — you never fill in a form for one.',
  sections: [
    {
      heading: 'Starting a proposal',
      where: 'Proposal → New proposal',
      steps: [
        {
          title: '1 · Date & event',
          body: 'Pick the From and To dates of the whole event, the event type and the guest’s name.',
          note: 'These two dates are the declared run. Every function and every room night must fall inside them, so set them wide enough before you go on. The event type is fixed once the proposal exists.',
          images: [
            {
              src: '/manual/booking-01-date-event.png',
              width: 1467,
              height: 870,
              alt: 'Step 1 of the wizard: From and To dates, event type and guest name',
            },
          ],
        },
        {
          title: '2 · KYC',
          body: 'Enter the contact numbers, then capture both sides of the Aadhaar with the camera or upload an image.',
          note: 'The number of contacts shown is required to confirm — a wedding asks for three. Aadhaar is NOT: you can add it here or later from the booking’s own page, so a date is never lost waiting for a card. Capture it all the same; the images are encrypted, and sending them over WhatsApp instead defeats that.',
          images: [
            {
              src: '/manual/booking-02-kyc.png',
              width: 1431,
              height: 1063,
              alt: 'Step 2: contact numbers, and Aadhaar front and back by camera or upload',
            },
          ],
        },
        {
          title: '3 · Functions & menu',
          body: 'Add each function with its date, time, venue, name and pax, then press Choose dishes on it. The one-tap names — Mehndi, Sangeet, Wedding, Reception, Tilak — fill the name for you, and each new function carries over the date, pax and menu of the one before it.',
          note: 'Venues only appear once the date and time are set, and only the free ones do. A hall can hold several functions in a day as long as the times do not overlap; an end time earlier than the start runs past midnight, which is what the “+1” means.',
          images: [
            {
              src: '/manual/booking-03-functions.png',
              width: 1341,
              height: 1006,
              alt: 'Step 3: the list of functions, each with a Choose dishes button, and the Add function form',
            },
          ],
        },
        {
          title: '4 · Rooms',
          body: 'Add a line per lodge and room category: how many, and the check-in and check-out dates. Each line tells you how many of that category are free on those exact nights as you type.',
          note: 'Room numbers are not chosen here — reception assigns those. Over 35 rooms on one booking goes to the GM: the rooms are written down either way, and the request is what has to clear before you confirm. The rooms total and its 5% both count toward the 25% advance.',
          images: [
            {
              src: '/manual/booking-04-rooms.png',
              width: 1423,
              height: 961,
              alt: 'Step 4: room requirement lines with live availability, and the rooms total with 5% tax',
            },
          ],
        },
        {
          title: '5 · Payment review',
          body: 'Check the totals, add any discount, record what the guest has actually paid, then Confirm.',
          note: 'Read the guest the Amount payable, never the Total printed on the proposal — the gap between them is the 18% nobody collects. Confirm needs some advance recorded: a receipt, not a promise. Nothing is held for zero.',
          images: [
            {
              src: '/manual/booking-05-payment-review.png',
              width: 1366,
              height: 1026,
              alt: 'Step 5: the totals, showing Amount payable, the 18% shown but not collected, the printed total and the advance required',
            },
          ],
        },
      ],
    },
    {
      heading: 'The menu',
      where: 'Proposal → Functions & menu → a function',
      steps: [
        {
          title: 'Pick the tier, then the dishes',
          body: 'Choose the per-plate tier first. Each segment carries its own allowance — “pick 3” — and counts up as the guest chooses. A segment marked “all included” is read-only: every dish on it comes anyway.',
          note: 'The function stays “Menu incomplete” until every segment with an allowance is full. That is not an error and it does not stop you confirming — but it does stop the event being locked at the end.',
          images: [
            {
              src: '/manual/booking-06-tier-list.png',
              width: 1342,
              height: 654,
              alt: 'The Menu (per plate) dropdown open on the Add function form, listing every tier',
            },
            {
              src: '/manual/booking-07-dish-picker.png',
              width: 1248,
              height: 1015,
              alt: 'The dish picker: an all-included segment, and a pick-3 segment with swap and increase',
            },
          ],
        },
        {
          title: 'Swap trades a dish, it does not add one',
          body: 'Press swap on a segment to open the full menu and take a dish that is not on this tier’s list. It comes in badged “swapped” and counts against the same allowance.',
          note: 'A swap is not an extra and never reaches the GM — the guest is taking three dishes where three were promised, just different ones. Use it when they want something off-list; use Increase when they want MORE.',
        },
        {
          title: 'Increase gives more, it does not add one',
          body: 'Pressing Increase on a segment removes its limit — the badge changes to “pick 4 +1”. Every dish taken past the original count is an extra and shows in violet.',
          note: 'Two extras per FUNCTION are free — not two per segment, which on a four-function wedding would be forty. The rest have to go to the GM.',
          images: [
            {
              src: '/manual/booking-08-extras.png',
              width: 1278,
              height: 1014,
              alt: 'A segment after Increase: the allowance reads pick 4 +1 and the extra dish is shown in violet',
            },
          ],
        },
        {
          title: 'Send the extras to the GM',
          body: 'The Extra dishes panel lists every extra on the function by name and tells you how many are free and how many are outstanding. Press “Send to the GM” when the guest has settled.',
          note: 'Sending is your call, and it is per function rather than saved up to the end. An extra that is never sent holds the whole event back at the lock.',
          images: [
            {
              src: '/manual/booking-09-send-to-gm.png',
              width: 1323,
              height: 978,
              alt: 'The Extra dishes panel with Send to the GM, the Chef delicacy box, and Add-ons',
            },
          ],
        },
        {
          title: 'Preferences',
          body: 'Press “+ preference” under any dish the guest has taken and type the instruction — “less spicy”, “no garlic”. It travels with that dish to the Banquet Manager’s day sheet and on to the kitchen.',
          note: 'A preference is never a charge, and it never changes the per-plate rate. If the guest wants something that is not on the card at all, that is a Chef delicacy instead.',
          images: [
            {
              src: '/manual/booking-10-preferences.png',
              width: 1176,
              height: 763,
              alt: 'Two segments of the picker with a preference note reading "less spicy" typed under a chosen dish',
            },
          ],
        },
        {
          title: 'Chef delicacy',
          body: 'Describe the off-menu dish and press “Ask the chef”. Only the Chef can put a price on it — you cannot, and neither can the GM.',
          note: 'Once priced it joins the per-plate rate, so it is multiplied by the pax and lands on the proposal total, the balance and the Draft. Until then it shows on the Banquet Manager’s board as awaiting the Chef’s price, so do not promise it to the guest as agreed.',
          images: [
            {
              src: '/manual/booking-11-chef-delicacy.png',
              width: 1245,
              height: 567,
              alt: 'The Chef delicacy box with "Sushi" typed and an Ask the chef button, above the Add-ons form',
            },
          ],
        },
        {
          title: 'Add-ons',
          body: 'Anything outside the tier — paan counter, an extra live counter — goes in as a description, a rate and a quantity.',
        },
      ],
    },
    {
      heading: 'Discounts',
      where: 'Payment review, or the booking’s Billing panel',
      steps: [
        {
          title: 'A discount is an amount of money',
          body: 'Pick the head it comes off — menu, venue, room or overall — type the rupees, and write the remark. The remark is required.',
        },
        {
          title: 'The 10% cap',
          body: 'Everything you give together must stay within 10% of the total bill. Inside that it applies at once.',
          note: 'Over the cap the discount is saved but does NOT come off the bill — it waits for the GM. Tell the guest the lower figure only once it is approved.',
        },
      ],
    },
    {
      heading: 'Asking the GM',
      steps: [
        {
          title: 'You do not raise a request by hand',
          body: 'Crossing a line raises it for you: a discount over 10%, more than 35 rooms, or menu extras past the two free ones when you press Send.',
        },
        {
          title: 'A venue, date or time change',
          body: 'On a confirmed booking use Request change. The slot is re-checked at the moment the GM approves it, not when you ask.',
        },
        {
          title: 'Where the answer arrives',
          body: 'The bell tells you the outcome, and Change requests lists the moves you asked for. The approvals queue itself is the GM’s screen — you will not see it.',
        },
        {
          title: 'Nothing locks with a request outstanding',
          body: 'A pending approval or change request holds the event back from being locked and billed. Chase it rather than working around it.',
        },
      ],
    },
    {
      heading: 'Money on the screen',
      steps: [
        {
          title: 'Two totals, always',
          body: 'Amount payable is what you collect. The Total printed on the proposal is that plus the 18%. Read the guest the Amount payable.',
          note: 'Rooms carry 5% and it IS collected. The 18% on venue, food and add-ons is printed for the record and collected from nobody — quoting the printed Total takes 18% too much. Every instalment, including the 25%, is a percentage of the Amount payable and never of the printed total.',
          images: [
            {
              src: '/manual/booking-12-money.png',
              width: 1320,
              height: 1050,
              alt: 'The totals: estimated total, less discounts, Amount payable, the 18% shown but not collected, the printed total and the advance required',
            },
          ],
        },
        {
          title: 'Maintenance lands late',
          body: 'Charges logged during or after the event — generator hours, extra staff, damages — join the amount payable once the Maintenance team closes them, and the balance grows by that much.',
          note: 'They do not change the 25% or the wedding 50%. Those fell due before the event ran, so a booking that met them stays met.',
        },
        {
          title: 'Downpayment due',
          body: 'A guest who brings part of the 25% still confirms and still holds the dates. The shortfall shows on the calendar in rose and on the booking.',
          note: 'There is no timer on it. When a competing enquiry appears for those dates, phone the GM — the guest’s number is on the calendar day panel — and the GM decides whether to cancel.',
        },
      ],
    },
  ],
}

const LODGE_MANAGER: RoleGuide = {
  role: 'lodge_manager',
  label: 'Lodging Manager',
  summary:
    'You watch one lodge. The calendar tells you what is committed on any night, by category and by guest.',
  sections: [
    {
      heading: 'Your lodge',
      steps: [
        {
          title: 'You see one lodge and no other',
          body: 'Your account is tied to a lodge, and every room screen is filtered to it.',
          note: 'If you see no rooms at all, no lodge is set on your account — ask the Admin to set one on the Users screen. It is a settings mistake, not an empty week.',
        },
      ],
    },
    {
      heading: 'Reading the calendar',
      where: 'Lodging calendar',
      steps: [
        {
          title: 'Thirty days at a glance',
          body: 'Each day shows how much of the lodge is taken, by category.',
        },
        {
          title: 'Open a date',
          body: 'Pick a day to see every booking holding rooms that night — the guest, the event code, the category and the count — and what is left vacant.',
        },
        {
          title: 'Counts, not room numbers',
          body: 'A booking reserves a lodge, a category, a count and dates. Which actual rooms those are is decided at reception on the day.',
        },
        {
          title: 'Only committed bookings appear',
          body: 'An enquiry holds nothing. Rooms are taken by whoever confirms first, so a busy enquiry list is not a full lodge.',
        },
      ],
    },
    {
      heading: 'The two limits',
      steps: [
        {
          title: 'The lodge cannot be oversold',
          body: 'A booking is refused outright if it would take more of a category than the lodge physically has free on the tightest night of that stay. This one is absolute — nobody can override it.',
        },
        {
          title: 'Over 35 rooms needs the GM',
          body: 'A booking above 35 rooms raises an approval. The rooms are written down straight away; the approval is what has to clear before the booking can be confirmed and locked.',
        },
      ],
    },
    {
      heading: 'Extras you give out on the day',
      where: 'Lodge extras',
      steps: [
        {
          title: 'Rooms beyond the booking',
          body: 'A party arrives bigger than it was booked and you find them rooms. Log the lodge, the category, how many and how many nights. The rate comes from the lodge master — you never type a price.',
          note: 'Do not add these to the booking’s own rooms. Those were priced and part-paid months ago; adding to them would move what the guest already owed.',
        },
        {
          title: 'In-room dining',
          body: 'One total in rupees for the whole stay. Saving replaces the last figure rather than adding to it, so put in the running total, not each order.',
        },
        {
          title: 'Nothing is charged until you close',
          body: 'While the log is open the guest is not being billed for any of it. Press Close lodge extras when the stay is over and the figures are final — that is what puts them on the bill.',
          note: 'After closing, the lines are frozen and neither you nor anyone else can change them — ask the Auditor if a figure turns out to be wrong.',
        },
      ],
    },
    {
      heading: 'Closing an event',
      steps: [
        {
          title: 'The rooms sign-off',
          body: 'Once an event has run, it appears on your dashboard under Awaiting your sign-off. Reconcile what was actually used against what the proposal committed, then press Sign off.',
          note: 'A booking that used rooms cannot be locked, invoiced or billed until you do. Only events that actually took rooms appear — the rest never needed you.',
        },
      ],
    },
  ],
}

const BANQUET_MANAGER: RoleGuide = {
  role: 'banquet_manager',
  label: 'Banquet Manager',
  summary:
    'Your screen is the fifteen-day board. It carries every confirmed function at your properties with its timings, pax and full menu.',
  sections: [
    {
      heading: 'Your properties',
      steps: [
        {
          title: 'The board is scoped to you',
          body: 'You see the functions at the properties you are responsible for, and no others. One manager can hold several.',
          note: 'If the board is empty when you expect functions, check with the Admin that your properties are set against your name on the Users screen.',
        },
      ],
    },
    {
      heading: 'The fifteen-day board',
      where: 'Next 15 days',
      steps: [
        {
          title: 'Today first, then the fortnight',
          body: 'Every confirmed function in order, with the guest, the venue, the start and end times and the pax count.',
        },
        {
          title: 'The full menu, per function',
          body: 'Each function carries its own menu: the tier, the per-plate rate and every dish segment by segment, as it was agreed.',
          note: 'The menu shown is a snapshot taken when it was saved. A later change to the master card does not move a function that is already booked.',
        },
        {
          title: 'Guest preferences',
          body: 'Notes the guest left against particular dishes — "dal spicy" and the like — appear with those dishes. Carry them to the kitchen; they are instructions, not charges.',
        },
        {
          title: 'Chef dishes',
          body: 'Off-menu delicacies appear alongside the tier menu. One still marked "awaiting the Chef’s price" has been asked for but not agreed — plan for it, but do not treat it as settled.',
        },
        {
          title: 'Add-ons',
          body: 'Extras outside the tier — a paan counter, an extra live counter — are listed with the function so the floor is set up for them.',
          note: 'The menu, the preferences and the add-ons are set by the Booking Manager on the proposal. Your board is the record of what was agreed; changes go through them.',
        },
      ],
    },
    {
      heading: 'Closing an event',
      steps: [
        {
          title: 'The day-sheet sign-off',
          body: 'Once the functions have run, the event appears on your dashboard under Awaiting your sign-off. Press it when they ran as they were listed.',
          note: 'No event can be locked, invoiced or billed until you do. You are only shown events at your own properties.',
        },
      ],
    },
  ],
}

export const MANUAL: RoleGuide[] = [BOOKING_MANAGER, LODGE_MANAGER, BANQUET_MANAGER]

/** The guide for a role, or null when that role has no manual yet. */
export function guideFor(roleName: string): RoleGuide | null {
  return MANUAL.find((g) => g.role === roleName) ?? null
}
