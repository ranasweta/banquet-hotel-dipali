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
          body: 'Pick the From and To dates of the whole event and the event type. Tick Wedding if it is one.',
          note: 'These two dates are the declared run. Every function and every room night must fall inside them, so set them wide enough before you go on.',
        },
        {
          title: '2 · KYC',
          body: "Enter the guest's name and number and upload both sides of the Aadhaar — camera or file.",
          note: 'Both sides are needed before the booking can be confirmed. The images are encrypted; never send them over WhatsApp instead.',
        },
        {
          title: '3 · Functions & menu',
          body: 'Add each function with its name, date, time, venue and pax. Free venues are shown as you set the date and time, so a clash is visible before you save.',
          note: 'A venue can hold several functions in one day as long as the times do not overlap. A function whose end time is earlier than its start time runs past midnight.',
        },
        {
          title: '4 · Rooms',
          body: 'Add a line per lodge and room category: how many, and the check-in and check-out dates. Room numbers are not chosen here — reception assigns those.',
          note: 'Over 35 rooms on one booking goes to the GM. The rooms are still written down; the request is what has to clear before you confirm.',
        },
        {
          title: '5 · Payment review',
          body: 'Check the totals, add any discount, record what the guest has actually paid, then Confirm.',
          note: 'Confirm needs some advance recorded — a receipt, not a promise. Nothing is held for zero.',
        },
      ],
    },
    {
      heading: 'The menu',
      where: 'Proposal → Functions & menu → a function',
      steps: [
        {
          title: 'Pick the tier, then the dishes',
          body: 'Choose the per-plate tier first. Each segment shows how many dishes the guest may take; segments where everything is included are read-only and always count as complete.',
        },
        {
          title: 'Increase gives more, it does not add one',
          body: 'Pressing Increase on a segment removes its limit. Every dish taken past the original count is marked as an extra.',
          note: 'Two extras per FUNCTION are free — not two per segment. The rest have to go to the GM.',
        },
        {
          title: 'Send the extras to the GM',
          body: 'When the guest has settled, press "Send to the GM" on that function. The GM is told which dishes are in question, by name.',
          note: 'Sending is your call and is done per function, not saved up until the end. An extra that is never sent will hold the event back at the lock.',
        },
        {
          title: 'Preferences',
          body: 'Type a note against a dish — "dal spicy", "less oil". It is a kitchen instruction that reaches the day sheet.',
          note: 'A preference is never a charge. If the guest wants something not on the card, that is a Chef delicacy instead.',
        },
        {
          title: 'Chef delicacy',
          body: 'Ask for an off-menu dish here. The Chef sets the per-plate charge; you cannot price it yourself.',
          note: 'Once priced it joins the per-plate rate and lands on the proposal total.',
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
          body: 'Total is with all tax on it. Amount payable is what you collect. Read the guest the Amount payable.',
          note: 'Rooms carry 5% and it is collected. The 18% on venue, food and add-ons is printed for the record and collected from nobody — quoting the Total takes 18% too much.',
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
