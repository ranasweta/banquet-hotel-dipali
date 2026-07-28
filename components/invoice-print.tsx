'use client'

import { useEffect, useState } from 'react'
import { Loader2, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, paiseToWords } from '@/lib/money'
import { Button } from '@/components/ui/button'
import type { ProposalDocument, ProposalFunction } from '@/lib/proposal'
import {
  HOTEL,
  TERMS_ACCEPTANCE,
  TERMS_ACCEPTANCE_FIELDS,
  TERMS_ACCEPTANCE_TITLE,
  TERMS_CLAUSES,
  TERMS_INTRO,
  TERMS_PAGE_1_CLAUSES,
  TERMS_TITLE,
} from '@/lib/terms'

/**
 * The printable proposal — a faithful rendering of the approved template
 * `Hotel-Dipali-Proposal-TEMPLATE_1.html`, followed by the Terms & Conditions annexure as a
 * facsimile of the client's PDF.
 *
 * THE TEMPLATE IS THE SPEC. Its eight blocks, in its order, with its class names: masthead →
 * Booking Overview → Estimate at a Glance → Functions & Menu (two cards per function, charges
 * then menu snapshot) → Accommodation → Statement of Charges → Payment → Inclusions & Notes.
 * Nothing here may be invented and nothing dropped; where the hotel has not supplied a value
 * yet (the bank block) the block still prints, blank, rather than quietly disappearing.
 *
 * TERMINOLOGY (client, 20 Jul 2026): the words "invoice" and "final" must never reach the
 * guest. There are exactly two documents a guest sees — **Draft** (an enquiry's provisional
 * estimate) and **Draft 2** (a confirmed booking's proposal). File and table names keep the
 * old wording internally; only what a human reads changes.
 *
 * Printing: Chrome/Edge → Ctrl/Cmd+P → Save as PDF, A4, "Background graphics" on.
 */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 'YYYY-MM-DD' parsed as a LOCAL date — `new Date(s)` would read it as UTC and shift a day. */
function ymd(s: string): { y: number; m: number; d: number; dow: number } {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return { y, m, d, dow: new Date(y, m - 1, d).getDay() }
}
/** 21 Nov 2026 */
const fmtDMY = (s: string | null) => (s ? `${ymd(s).d} ${MON[ymd(s).m - 1]} ${ymd(s).y}` : '—')
/** 21 Nov */
const fmtDM = (s: string | null) => (s ? `${ymd(s).d} ${MON[ymd(s).m - 1]}` : '—')
/** Sat, 21 November 2026 */
const fmtLong = (s: string | null) => {
  if (!s) return '—'
  const t = ymd(s)
  return `${DAY[t.dow]}, ${t.d} ${MON_LONG[t.m - 1]} ${t.y}`
}
/** '18:30:00' → '6:30 PM' */
function fmtTime(t: string): string {
  const [h, m] = t.split(':').map(Number) as [number, number]
  const ap = h >= 12 ? 'PM' : 'AM'
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`
}

/**
 * What the document calls itself. Chrome writes the page title onto the saved PDF, so without
 * this every proposal saves as "Hotel Dipali — Banquet Management" and a folder of them is
 * indistinguishable. Guest-facing, so it uses the Draft / Draft 2 vocabulary and the booking
 * code — never the word "invoice" (client, 20 Jul 2026):
 *
 *     Draft 2 - E-1042 - Rajesh Verma - 20 Nov 2026
 *
 * Characters a filesystem refuses are folded to spaces rather than left for Chrome to mangle.
 */
export function proposalDocumentName(doc: ProposalDocument): string {
  const stage = doc.doc.isDraft2 ? 'Draft 2' : 'Draft'
  const when = doc.event.plannedFrom ?? doc.event.firstDate
  return [stage, doc.event.code, doc.event.guestName, when ? fmtDMY(when) : null]
    .filter(Boolean)
    .join(' - ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function InvoicePrint({ eventId, proforma = false }: { eventId: string; proforma?: boolean }) {
  const [doc, setDoc] = useState<ProposalDocument | null>(null)

  useEffect(() => {
    api<ProposalDocument>(proforma ? `/events/${eventId}/proforma` : `/events/${eventId}/invoice/print`)
      .then(setDoc)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [eventId, proforma])

  // Name the saved PDF after the proposal, and hand the title back on the way out so the rest
  // of the app keeps its own.
  useEffect(() => {
    if (!doc) return
    const previous = document.title
    document.title = proposalDocumentName(doc)
    return () => {
      document.title = previous
    }
  }, [doc])

  if (!doc) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    )
  }

  return (
    <>
      {/* Toolbar — never printed. */}
      <div className="mx-auto mb-3 flex max-w-[210mm] items-center justify-between gap-3 px-1 print:hidden">
        <p className="text-sm text-muted-foreground">
          Press Print, then <span className="font-medium text-foreground">Save as PDF</span> — A4, background graphics
          on, <span className="font-medium text-foreground">headers &amp; footers off</span>.
        </p>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="size-4" /> Print
        </Button>
      </div>
      <ProposalSheet doc={doc} />
    </>
  )
}

/**
 * The document itself — pure, so it renders from a `ProposalDocument` and nothing else.
 * Keeping it free of fetching is what lets the markup be checked against the template
 * without a database or a browser session.
 */
export function ProposalSheet({ doc }: { doc: ProposalDocument }) {
  const { event, contacts, functions, lodges, extras, totals, counts } = doc
  const docName = doc.doc.isDraft2 ? 'DRAFT 2' : 'DRAFT'
  const words = paiseToWords(totals.totalPaise)
  const runFrom = event.plannedFrom ?? event.firstDate
  const runTo = event.plannedTo ?? event.lastDate

  return (
    <div className="pd">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="page">
        <table className="sheet">
          <thead>
            <tr>
              <td>
                <div className="gild" />
              </td>
            </tr>
          </thead>
          <tfoot>
            <tr>
              <td>
                <div className="runfoot-rule" />
              </td>
            </tr>
          </tfoot>
          <tbody>
            <tr>
              <td>
                {/* ══════════ MASTHEAD ══════════ */}
                <header className="masthead">
                  <div className="mh-grid">
                    <div>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className="logo-img" alt="Hotel Dipali" src="/hotel-dipali-logo.png" />
                      <div className="brand-sub">Sagar · Banquets · Lodging</div>
                    </div>

                    <div className="doc-side">
                      <div className="doc-kicker">Booking Estimate</div>
                      <div className="doc-title">PROPOSAL</div>
                      <div className="doc-rule" />
                      <div className="meta-chips">
                        <div className="chip stamp">
                          <span>Status</span> <b>{docName}</b>
                        </div>
                        <div className="chip">
                          <span>Booking</span> <b>{event.code}</b>
                        </div>
                        <div className="chip">
                          <span>Issued</span> <b>{fmtDMY(doc.doc.issuedOn)}</b>
                        </div>
                        {doc.doc.documentNo && (
                          <div className="chip">
                            <span>No.</span> <b>{doc.doc.documentNo}</b>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mh-contact">
                    <div>
                      <i>◆</i>
                      {HOTEL.address}
                    </div>
                    <div>
                      <i>◆</i>
                      {HOTEL.phone}
                    </div>
                    <div>
                      <i>◆</i>
                      {HOTEL.email}
                    </div>
                    <div>
                      <i>◆</i>GSTIN {HOTEL.gstin}
                    </div>
                    <div>
                      <i>◆</i>FSSAI {HOTEL.fssai}
                    </div>
                  </div>
                </header>

                <div className="pad">
                  {/* ══════════ OVERVIEW ══════════ */}
                  <PillRow title="Booking Overview" tag="Guest · Declared run · Scope" />

                  <div className="cards avoid">
                    <div className="card">
                      <div className="card-label">Proposal prepared for</div>
                      <div className="card-name">{event.guestName}</div>
                      <dl className="kv">
                        <dt>Event type</dt>
                        <dd>{event.eventTypeLabel}</dd>
                      </dl>
                      {contacts.map((c) => (
                        <dl className="kv" key={c.phone}>
                          <dt>{CONTACT_LABEL[(c.label ?? '').toLowerCase()] ?? c.label ?? 'Contact'}</dt>
                          <dd>{c.phone}</dd>
                        </dl>
                      ))}
                    </div>
                    <div className="card warm">
                      <div className="card-label">Declared run &amp; scope</div>
                      <div className="card-name">{event.eventTypeLabel}</div>
                      <dl className="kv">
                        <dt>Run</dt>
                        <dd>
                          {fmtDM(runFrom)} — {fmtDMY(runTo)}
                        </dd>
                      </dl>
                      <dl className="kv">
                        <dt>Functions</dt>
                        <dd>
                          {counts.functions}
                          {functions.length > 0 && ` · ${functions.map((f) => fmtLong(f.date)).join(' · ')}`}
                        </dd>
                      </dl>
                      <dl className="kv">
                        <dt>Pax</dt>
                        <dd>
                          {counts.pax} guests
                          {functions.length > 1 && ` (${functions.map((f) => `${f.name} ${f.pax}`).join(', ')})`}
                        </dd>
                      </dl>
                      <dl className="kv">
                        <dt>Rooms</dt>
                        <dd>
                          {counts.rooms} rooms · {counts.roomNights} room-nights
                        </dd>
                      </dl>
                    </div>
                  </div>

                  {/* ══════════ GLANCE ══════════ */}
                  <PillRow title="Estimate at a Glance" tag="Detailed break-up follows" />

                  <div className="glance avoid">
                    <div className="gt">
                      <div className="gl2">Venue · Food · Add-ons</div>
                      <div className="gv2">{formatPaise(totals.proposalPaise)}</div>
                      <div className="gs">
                        {counts.functions} functions · {counts.pax} pax
                      </div>
                    </div>
                    <div className="gt">
                      <div className="gl2">Accommodation</div>
                      <div className="gv2">{formatPaise(totals.roomsPaise)}</div>
                      <div className="gs">
                        {counts.rooms} rooms · {counts.roomNights} nights
                      </div>
                    </div>
                    <div className="gt">
                      <div className="gl2">Room tax @ 5%</div>
                      <div className="gv2">{formatPaise(totals.roomsTaxPaise)}</div>
                      <div className="gs">Rooms are the only taxed head</div>
                    </div>
                    <div className="gt hi">
                      <div className="gl2">Estimated Total</div>
                      <div className="gv2">{formatPaise(totals.totalPaise)}</div>
                      <div className="gs">Advance 25% · {formatPaise(totals.advancePaise)}</div>
                    </div>
                  </div>

                  {/* ══════════ FUNCTIONS ══════════ */}
                  {functions.length > 0 && <PillRow title="Functions & Menu" tag="Venue · Food · Add-ons" />}

                  {functions.map((f) => (
                    <FunctionBlock key={`${f.name}-${f.date}-${f.startTime}`} fn={f} />
                  ))}

                  {/* ══════════ ROOMS ══════════ */}
                  {lodges.length > 0 && (
                    <>
                      <PillRow title="Accommodation" tag="Rack-rate estimate" />
                      <div className="fn avoid">
                        <div className="fn-bar">
                          <div className="fn-name">
                            Rooms
                            <em>
                              {counts.rooms} rooms · {counts.roomNights} room-nights
                            </em>
                          </div>
                          <div className="fn-meta">
                            {lodges.map((l) => (
                              <span className="mchip" key={l.name}>
                                {l.name} · {l.rooms}
                              </span>
                            ))}
                            <span className="mchip solid">
                              {lodges.length} {lodges.length === 1 ? 'LODGE' : 'LODGES'}
                            </span>
                          </div>
                        </div>
                        <table>
                          <thead>
                            <tr>
                              <th style={{ width: '46%' }}>Lodge / Category</th>
                              <th className="c" style={{ width: '12%' }}>
                                Rooms
                              </th>
                              <th className="n" style={{ width: '18%' }}>
                                Nights × Rate
                              </th>
                              <th className="n" style={{ width: '24%' }}>
                                Amount (₹)
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {lodges.map((l) => (
                              <Lodge key={l.name} lodge={l} multi={lodges.length > 1} />
                            ))}
                            <tr className="sub">
                              <td colSpan={3} className="lbl">
                                Accommodation sub-total &nbsp;·&nbsp; {counts.rooms} rooms · {counts.roomNights} room-nights
                              </td>
                              <td className="n val">{formatPaise(totals.roomsPaise)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {/* ══════════ EXTRAS ══════════
                      Not a template block: post-event maintenance and the Auditor's
                      adjustments have no row in the proposal. It stays out of the document
                      entirely until the app actually has some (client ruling). */}
                  {extras.length > 0 && (
                    <>
                      <PillRow title="Extras" tag="Logged after the event · billed on actuals" />
                      <div className="fn avoid">
                        <div className="fn-bar">
                          <div className="fn-name">
                            Extras<em>Billed on actuals</em>
                          </div>
                        </div>
                        <table>
                          <thead>
                            <tr>
                              <th style={{ width: '46%' }}>Particulars</th>
                              <th className="c" style={{ width: '12%' }}>
                                Qty
                              </th>
                              <th className="n" style={{ width: '18%' }}>
                                Rate
                              </th>
                              <th className="n" style={{ width: '24%' }}>
                                Amount (₹)
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {extras.map((x) => (
                              <tr key={x.description}>
                                <td>
                                  <span className="it-name">{x.description}</span>
                                </td>
                                <td className="c calc">{x.qty}</td>
                                <td className="n calc">{formatPaise(x.ratePaise)}</td>
                                <td className="n amt">{formatPaise(x.amountPaise)}</td>
                              </tr>
                            ))}
                            <tr className="sub">
                              <td colSpan={3} className="lbl">
                                Extras sub-total
                              </td>
                              <td className="n val">{formatPaise(totals.extrasPaise)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {/* ══════════ STATEMENT ══════════ */}
                  <PillRow title="Statement of Charges" tag="Sub-totals · Tax · Advance" />

                  <div className="summary avoid">
                    <div className="sum-in">
                      <div className="sum-h">Break-up</div>
                      <div className="sledger">
                        <div className="sline">
                          <div className="l">
                            Venue, Food &amp; Add-ons <small>proposal total</small>
                          </div>
                          <div className="v">{formatPaise(totals.proposalPaise)}</div>
                        </div>
                        <div className="sline">
                          <div className="l">
                            Accommodation{' '}
                            <small>
                              {counts.rooms} rooms · {counts.roomNights} room-nights
                            </small>
                          </div>
                          <div className="v">{formatPaise(totals.roomsPaise)}</div>
                        </div>
                        {extras.length > 0 && (
                          <div className="sline">
                            <div className="l">
                              Extras <small>billed on actuals</small>
                            </div>
                            <div className="v">{formatPaise(totals.extrasPaise)}</div>
                          </div>
                        )}
                        <div className="sline">
                          <div className="l">
                            Discount <small>max 10% of proposal total</small>
                          </div>
                          <div className="v">— {formatPaise(totals.discountPaise)}</div>
                        </div>
                        <div className="sline">
                          <div className="l">
                            Sub-total <small>before tax</small>
                          </div>
                          <div className="v">{formatPaise(totals.subtotalPaise)}</div>
                        </div>
                        <div className="sline tax">
                          <div className="l">
                            Tax — 5% on rooms <small>on {formatPaise(totals.roomsPaise)}</small>
                          </div>
                          <div className="v">+ {formatPaise(totals.roomsTaxPaise)}</div>
                        </div>
                      </div>
                      <div className="trow">
                        <div className="tl">Estimated Total</div>
                        <div className="tv">{formatPaise(totals.totalPaise)}</div>
                      </div>
                      <div className="words">
                        Rupees {words.rupees} and {words.paise} Paise Only.
                      </div>
                      <div className="adv">
                        <div className="adv-box hi">
                          <div className="al">To confirm today · 25%</div>
                          <div className="av">{formatPaise(totals.advancePaise)}</div>
                        </div>
                        <div className="adv-box">
                          <div className="al">Balance · 30 days before event</div>
                          <div className="av">{formatPaise(totals.balancePaise)}</div>
                        </div>
                        {totals.advancesReceivedPaise > 0 && (
                          <>
                            <div className="adv-box">
                              <div className="al">Received so far</div>
                              <div className="av">{formatPaise(totals.advancesReceivedPaise)}</div>
                            </div>
                            <div className="adv-box">
                              <div className="al">Outstanding</div>
                              <div className="av">{formatPaise(totals.totalPaise - totals.advancesReceivedPaise)}</div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* ══════════ PAYMENT ══════════ */}
                  <PillRow title="Payment" tag="Advance base includes rooms & room tax" />

                  <div className="pay avoid">
                    <div className="pstep">
                      <div className="ph">Advance block · to confirm</div>
                      <div className="pb">
                        <div className="pct">25%</div>
                        <div className="pamt">{formatPaise(totals.advancePaise)}</div>
                        <div className="pwhen">On receipt, venue windows are blocked and the booking moves to Confirmed.</div>
                      </div>
                    </div>
                    <div className="pstep">
                      <div className="ph">Balance · 30 days before event</div>
                      <div className="pb">
                        <div className="pct">75%</div>
                        <div className="pamt">{formatPaise(totals.balancePaise)}</div>
                        <div className="pwhen">Payable in full at least 30 days before the event. Cheques subject to realisation.</div>
                      </div>
                    </div>
                    <div className="pstep">
                      <div className="ph">Extras · before checkout</div>
                      <div className="pb">
                        <div className="pct" style={{ fontSize: '12.5pt' }}>
                          On actuals
                        </div>
                        <div className="pamt">Before final checkout</div>
                        <div className="pwhen">Additional charges incurred during the event, settled against Draft 2.</div>
                      </div>
                    </div>
                  </div>

                  {/* Bank block prints blank until the hotel supplies the details (client ruling). */}
                  <div className="bank avoid">
                    <div>
                      <div className="bl">A/C Name</div>
                      <div className="bv">{doc.bank.accountName}</div>
                    </div>
                    <div>
                      <div className="bl">A/C No.</div>
                      <div className="bv">{doc.bank.accountNo}</div>
                    </div>
                    <div>
                      <div className="bl">IFSC</div>
                      <div className="bv">{doc.bank.ifsc}</div>
                    </div>
                    <div>
                      <div className="bl">Bank</div>
                      <div className="bv">{doc.bank.bank}</div>
                    </div>
                    <div>
                      <div className="bl">UPI</div>
                      <div className="bv">{doc.bank.upi}</div>
                    </div>
                  </div>

                  {/* ══════════ INCLUSIONS ══════════ */}
                  <PillRow title="Inclusions & Notes" tag="What this estimate covers" />

                  <div className="two avoid">
                    <div className="panel">
                      <h4>Included in this estimate</h4>
                      <ul>
                        {functions.some((f) => f.venueName) && (
                          <li>
                            <b>Venue</b> — exclusive hold on{' '}
                            {[...new Set(functions.map((f) => f.venueName).filter(Boolean))].join(', ')}.
                          </li>
                        )}
                        {functions.some((f) => f.menu) && (
                          <li>
                            <b>Food</b> —{' '}
                            {functions
                              .filter((f) => f.menu)
                              .map((f) => `${f.menu!.tierName}, ${formatPaise(f.menu!.perPlatePaise)}/plate on ${f.pax} guaranteed pax`)
                              .join('; ')}
                            .
                          </li>
                        )}
                        {lodges.length > 0 && (
                          <li>
                            <b>Rooms</b> — {counts.rooms} rooms / {counts.roomNights} room-nights, {lodges.map((l) => l.name).join(', ')}.
                          </li>
                        )}
                        <li>
                          <b>Room tax</b> — 5%, on the accommodation head only.
                        </li>
                        {functions.flatMap((f) => f.addons.filter((a) => a.ratePaise === 0)).length > 0 && (
                          <li>
                            <b>Complimentary</b> —{' '}
                            {[...new Set(functions.flatMap((f) => f.addons.filter((a) => a.ratePaise === 0).map((a) => a.description)))].join(', ')}.
                          </li>
                        )}
                      </ul>
                    </div>
                    <div className="panel">
                      <h4>Not included / billed on actuals</h4>
                      <ul>
                        <li>
                          <b>Maintenance entries</b> — post-event extras, added once logged.
                        </li>
                        <li>
                          <b>Menu extras</b> — two per function free; further extras chargeable on approval.
                        </li>
                        <li>
                          <b>Extra pax</b> beyond the guaranteed count, at the same rate.
                        </li>
                        <li>
                          <b>Décor, lighting, stage, sound, LED, DJ</b> — charged separately (Annexure cl. 8).
                        </li>
                      </ul>
                    </div>
                  </div>

                  <div className="note avoid">
                    <b>Terms &amp; Conditions.</b> The two-page <b>Terms and Conditions for Banquet Booking</b> annexure accompanies
                    this proposal and forms an integral part of it. Payment of the advance or written acceptance constitutes acceptance
                    of those Terms — please sign and return both.
                  </div>

                  <div className="sign avoid">
                    <div className="sig">
                      <div className="line" />
                      <div className="who">Accepted by the Guest</div>
                      <div className="sub">Name, signature &amp; date</div>
                    </div>
                    <div className="sig">
                      <div className="line" />
                      <div className="who">For Hotel Dipali</div>
                      <div className="sub">Authorised Signatory</div>
                    </div>
                  </div>
                </div>

                <div className="footer">
                  <div className="thanks">We look forward to hosting your celebration.</div>
                  <div>
                    Hotel Dipali Sagar · +91 07582 263910 · Proposal {event.code} · {doc.doc.isDraft2 ? 'Draft 2' : 'Draft'}
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ══════════ TERMS & CONDITIONS ANNEXURE — facsimile of the client's PDF ══════════ */}
      <TermsAnnexure />
    </div>
  )
}

const CONTACT_LABEL: Record<string, string> = {
  primary: 'Primary',
  father: 'Father',
  coordinator: 'Co-ord.',
}

function PillRow({ title, tag }: { title: string; tag: string }) {
  return (
    <div className="pill-row">
      <div className="pill">
        <span className="gem" />
        {title}
      </div>
      <div className="hair" />
      <div className="tag">{tag}</div>
    </div>
  )
}

/** One function: its charges card, then its menu snapshot card — the template's pairing. */
function FunctionBlock({ fn }: { fn: ProposalFunction }) {
  const surcharge = fn.menu?.surchargePaise ?? 0
  const chef = fn.menu?.chefPaise ?? 0

  return (
    <>
      <div className="fn avoid">
        <div className="fn-bar">
          <div className="fn-name">{fn.name}</div>
          <div className="fn-meta">
            <span className="mchip">{fmtDMY(fn.date)}</span>
            <span className="mchip">
              {fmtTime(fn.startTime)} – {fmtTime(fn.endTime)}
              {fn.overnight ? ' [+1]' : ''}
            </span>
            <span className="mchip solid">{fn.pax} PAX</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: '46%' }}>Particulars</th>
              <th className="c" style={{ width: '12%' }}>
                Qty
              </th>
              <th className="n" style={{ width: '18%' }}>
                Rate
              </th>
              <th className="n" style={{ width: '24%' }}>
                Amount (₹)
              </th>
            </tr>
          </thead>
          <tbody>
            {fn.venueName && (
              <tr>
                <td>
                  <span className="it-name">Venue — {fn.venueName}</span>
                  <span className="it-desc">
                    Rate card for this venue &amp; event type.
                    {fn.isBundle &&
                      ` A bundle books every member venue${fn.bundleMembers.length ? ` (${fn.bundleMembers.join(', ')})` : ''}.`}
                  </span>
                </td>
                <td className="c calc">1 event</td>
                {/* BR-R1: no rate card is a gate, never a zero. */}
                <td className="n calc">{fn.venueRatePaise == null ? 'On approval' : formatPaise(fn.venueRatePaise)}</td>
                <td className="n amt">{fn.venueRatePaise == null ? '—' : formatPaise(fn.venueRatePaise)}</td>
              </tr>
            )}
            {fn.menu && (
              <tr>
                <td>
                  <span className="it-name">Food — {fn.menu.tierName}</span>
                  <span className="it-desc">
                    Base {formatPaise(fn.menu.baseRatePaise)}
                    {surcharge > 0 && ` + wedding surcharge ${formatPaise(surcharge)}`}
                    {chef > 0 && ` + chef speciality ${formatPaise(chef)}`}
                    {(surcharge > 0 || chef > 0) && ` = ${formatPaise(fn.menu.perPlatePaise)}`} per plate.
                  </span>
                </td>
                <td className="c calc">{fn.pax} pax</td>
                <td className="n calc">{formatPaise(fn.menu.perPlatePaise)} / plate</td>
                <td className="n amt">{formatPaise(fn.foodAmountPaise)}</td>
              </tr>
            )}
            {fn.addons.map((a) =>
              a.ratePaise === 0 ? (
                <tr key={a.description}>
                  <td>
                    <span className="it-name">{a.description}</span>
                    <span className="it-desc">Shown at nil value.</span>
                  </td>
                  <td className="c calc">{a.qty}</td>
                  <td className="n calc">
                    <span className="free">COMPLIMENTARY</span>
                  </td>
                  <td className="n amt">{formatPaise(0)}</td>
                </tr>
              ) : (
                <tr key={a.description}>
                  <td>
                    <span className="it-name">Add-on — {a.description}</span>
                  </td>
                  <td className="c calc">{a.qty}</td>
                  <td className="n calc">{formatPaise(a.ratePaise)}</td>
                  <td className="n amt">{formatPaise(a.amountPaise)}</td>
                </tr>
              ),
            )}
            <tr className="sub">
              <td colSpan={3} className="lbl">
                {fn.name} sub-total
              </td>
              <td className="n val">{formatPaise(fn.subtotalPaise)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {fn.menu && (
        <div className="fn avoid">
          <div className="fn-bar">
            <div className="fn-name">
              Menu
              <em>
                {fn.menu.tierName} · {fn.name}
              </em>
            </div>
            <div className="fn-meta">
              <span className="mchip">{formatPaise(fn.menu.perPlatePaise)} / plate</span>
              <span className="mchip">{fn.menu.segments.length} segments</span>
              <span className="mchip solid">2 EXTRAS FREE</span>
            </div>
          </div>
          <div className="menu-body">
            <div className="menu-grid">
              {fn.menu.segments.map((s) => (
                <div className="seg" key={s.name}>
                  <div className="seg-h">
                    <span className="seg-n">{s.name}</span>
                    <span className="seg-c">{s.basePick == null ? 'All included' : `${s.picked} of ${s.basePick}`}</span>
                  </div>
                  <ul className="dishes">
                    {s.dishes.map((d) => (
                      <li key={d.name} className={d.isExtra ? 'x' : undefined}>
                        {d.name}
                        {d.note ? ` (${d.note})` : ''}
                        {d.isExtra && <em>Extra</em>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="menu-note">
              <b>Segments marked “All included”</b> carry every dish in that category. Picks beyond the tier’s base count are shown
              as <b>Extra</b> — two extras per function are complimentary; any further extras are approved and charged separately.
              This is the menu snapshot as at the date of issue.
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** One lodge: its group header, its stay lines, then its own sub-total. */
function Lodge({ lodge, multi }: { lodge: ProposalDocument['lodges'][number]; multi: boolean }) {
  return (
    <>
      <tr className="grp">
        <td colSpan={3}>
          <span className="gname">{lodge.name}</span>
        </td>
        <td className="n">
          <span className="gnote">{lodge.roomNights} room-nights</span>
        </td>
      </tr>
      {lodge.lines.map((l) => (
        <tr key={`${l.roomType}-${l.checkIn}-${l.checkOut}`}>
          <td>
            <span className="it-name">
              {l.roomType.replace(/_/g, ' ')}{' '}
              <span className="dates">
                · {fmtDM(l.checkIn)} → {fmtDM(l.checkOut)}
              </span>
            </span>
          </td>
          <td className="c calc">{l.count}</td>
          <td className="n calc">
            {l.nights} × {formatPaise(l.ratePaise)}
          </td>
          <td className="n amt">{formatPaise(l.amountPaise)}</td>
        </tr>
      ))}
      {multi && (
        <tr className="subx">
          <td colSpan={3} className="lbl">
            {lodge.name} sub-total
          </td>
          <td className="n val">{formatPaise(lodge.subtotalPaise)}</td>
        </tr>
      )}
    </>
  )
}

/**
 * The Terms & Conditions annexure, reproduced from
 * "DRAFT - TERMS AND CONDITIONS FOR BANQUET BOOKING.pdf" rather than redesigned: the boxed
 * page, the centred masthead, bold "N. Title" headings each over its own bullet(s), the break
 * after clause 12, the CLIENT ACCEPTANCE block, and the signature + "Page N of 2" footer.
 */
function TermsAnnexure() {
  const page1 = TERMS_CLAUSES.slice(0, TERMS_PAGE_1_CLAUSES)
  const page2 = TERMS_CLAUSES.slice(TERMS_PAGE_1_CLAUSES)

  return (
    <>
      <div className="tcpage">
        <div className="tcbox">
          <div className="tchead">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="tclogo" alt="Hotel Dipali" src="/hotel-dipali-logo.png" />
            <div className="tcname">HOTEL DIPALI SAGAR</div>
            <div className="tcaddr">{HOTEL.address}, India</div>
            <div className="tcaddr">
              M: +91 07582263910/9109993582 E: {HOTEL.email}
            </div>
            <div className="tcaddr">
              GSTN: {HOTEL.gstin} FSSAI: {HOTEL.fssai}
            </div>
          </div>

          <div className="tctitle">{TERMS_TITLE.toUpperCase()}</div>
          <p className="tcintro">{TERMS_INTRO}</p>

          <div className="tcbody">
            {page1.map((c, i) => (
              <Clause key={c.title} n={i + 1} clause={c} />
            ))}
          </div>

          <TermsFoot page={1} />
        </div>
      </div>

      <div className="tcpage">
        <div className="tcbox">
          <div className="tcbody">
            {page2.map((c, i) => (
              <Clause key={c.title} n={TERMS_PAGE_1_CLAUSES + i + 1} clause={c} />
            ))}

            <div className="tcaccept">
              <div className="tcah">{TERMS_ACCEPTANCE_TITLE}</div>
              <p className="tcaintro">{TERMS_ACCEPTANCE}</p>
              <table className="tcfields">
                <tbody>
                  {TERMS_ACCEPTANCE_FIELDS.map((f) => (
                    <tr key={f.label}>
                      <td className="tcfl">{f.label}</td>
                      <td className="tcfc">:</td>
                      <td className="tcfv">{f.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <TermsFoot page={2} />
        </div>
      </div>
    </>
  )
}

function Clause({ n, clause }: { n: number; clause: (typeof TERMS_CLAUSES)[number] }) {
  return (
    <div className="tccl">
      <div className="tcn">
        {n}. {clause.title}
      </div>
      <ul>
        {clause.bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </div>
  )
}

function TermsFoot({ page }: { page: number }) {
  return (
    <div className="tcfoot">
      <div className="tcsigs">
        <span>Client Signature</span>
        <span>
          Authorised Signatory
          <br />
          Hotel Dipali
        </span>
      </div>
      <div className="tcpageno">Page {page} of 2</div>
    </div>
  )
}

/**
 * The template's own stylesheet, scoped to `.pd` so it cannot leak into the app shell. Rules
 * are the template's verbatim; only the selectors are prefixed, `body` becomes `.pd`, and the
 * annexure block at the end is new. Cormorant Garamond arrives from next/font as
 * `--font-display` (app/layout.tsx) so a printed PDF never waits on a webfont request.
 */
const CSS = `
.pd{
  --ink:#2A2620; --ink-2:#4A443B; --soft:#7C7466; --faint:#A79E8C;
  --gold-deep:#8C6E1F; --gold:#B8912F; --gold-mid:#C9A227; --gold-lite:#DFC276;
  --gold-pale:#F1E4C2; --champagne:#FBF5E6; --champagne-2:#F6EDD8;
  --ivory:#FFFDF7; --paper:#FFFFFF;
  --rule:#E6D8AF; --rule-soft:#EFE7D4;
  --serif:var(--font-display),'Cormorant Garamond',Georgia,'Times New Roman',serif;
  --sans:var(--font-sans),'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-family:var(--sans); color:var(--ink); background:#EDE8DD;
  font-size:10.5pt; line-height:1.5; -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums; padding:24px 12px;
}
.pd *{box-sizing:border-box; margin:0; padding:0}
.pd .page{width:210mm; margin:0 auto; background:var(--paper); position:relative;
  box-shadow:0 18px 60px rgba(90,75,40,.22)}
.pd .pad{padding:0 16mm}

/* ══════════ MASTHEAD ══════════ */
.pd .gild{height:4px; background:linear-gradient(90deg,
  var(--gold-deep) 0%,var(--gold-lite) 18%,#FBF0D2 34%,var(--gold-mid) 50%,
  #FBF0D2 66%,var(--gold-lite) 82%,var(--gold-deep) 100%)}
.pd .masthead{padding:9mm 16mm 7mm; background:linear-gradient(180deg,var(--ivory) 0%,#fff 78%);
  border-bottom:1px solid var(--rule); position:relative}
.pd .mh-grid{display:flex; justify-content:space-between; align-items:flex-start; gap:12mm}
.pd .logo-img{height:25mm; width:auto; display:block; mix-blend-mode:multiply}
.pd .brand-sub{font-size:6pt; letter-spacing:.24em; text-transform:uppercase; white-space:nowrap;
  color:var(--gold-deep); margin-top:5px; padding-left:2px}
.pd .doc-side{text-align:right}
.pd .doc-kicker{font-size:6.4pt; letter-spacing:.34em; text-transform:uppercase; color:var(--soft)}
.pd .doc-title{font-family:var(--serif); font-size:31pt; font-weight:600; line-height:1.02;
  letter-spacing:.06em; color:var(--gold-deep); margin:3px 0 1px}
.pd .doc-rule{height:1px; background:linear-gradient(90deg,rgba(230,216,175,0),var(--gold-lite));
  margin:5px 0 8px}
.pd .meta-chips{display:flex; gap:5px; justify-content:flex-end; flex-wrap:wrap}
.pd .chip{border:1px solid var(--rule); border-radius:999px; padding:3.5px 11px;
  font-size:6.9pt; white-space:nowrap; background:var(--champagne)}
.pd .chip span{color:var(--faint); text-transform:uppercase; letter-spacing:.16em; font-size:6pt}
.pd .chip b{color:var(--gold-deep); font-weight:700; letter-spacing:.03em}
.pd .chip.stamp{background:linear-gradient(135deg,#F6EAC9,#EFDFB4); border-color:var(--gold-lite)}
.pd .chip.stamp b{color:#7A5E15}
.pd .mh-contact{display:flex; gap:14px; flex-wrap:wrap; margin-top:7mm; padding-top:4mm;
  border-top:1px solid var(--rule-soft); font-size:7.3pt; color:var(--soft)}
.pd .mh-contact i{color:var(--gold-lite); font-style:normal; margin-right:5px}

/* ══════════ PILL HEADERS ══════════ */
.pd .pill{display:inline-flex; align-items:center; gap:9px;
  background:linear-gradient(180deg,#FEFAF0,var(--champagne-2));
  border:1px solid var(--rule); color:var(--gold-deep); border-radius:999px;
  padding:6.5px 20px 6.5px 14px; font-size:7.4pt; font-weight:700;
  letter-spacing:.22em; text-transform:uppercase;
  box-shadow:0 1px 0 #fff inset, 0 2px 6px rgba(140,110,31,.07)}
.pd .pill .gem{width:8px; height:8px; transform:rotate(45deg); border-radius:1.5px; flex:none;
  background:linear-gradient(135deg,var(--gold-lite),var(--gold-deep))}
.pd .pill-row{display:flex; align-items:center; gap:11px; margin:3.6mm 0 2.4mm}
.pd .pill-row .hair{flex:1; height:1px; background:linear-gradient(90deg,var(--gold-lite),rgba(223,194,118,0))}
.pd .pill-row .tag{font-size:6.8pt; letter-spacing:.17em; text-transform:uppercase;
  color:var(--faint); white-space:nowrap}

/* ══════════ CARDS ══════════ */
.pd .cards{display:grid; grid-template-columns:1fr 1fr; gap:5mm}
.pd .card{border:1px solid var(--rule-soft); border-radius:16px; padding:5mm 5.5mm;
  background:linear-gradient(180deg,var(--ivory),#fff 70%)}
.pd .card.warm{background:linear-gradient(170deg,#FDF7E9,var(--champagne)); border-color:var(--rule)}
.pd .card-label{font-size:6.4pt; letter-spacing:.26em; text-transform:uppercase;
  color:var(--gold-deep); font-weight:700; margin-bottom:8px}
.pd .card-name{font-family:var(--serif); font-size:16.5pt; font-weight:600; line-height:1.14;
  color:var(--ink); margin-bottom:6px}
.pd .kv{display:flex; gap:8px; font-size:8.3pt; line-height:1.7}
.pd .kv dt{width:60px; flex:none; color:var(--faint); font-size:7.2pt; letter-spacing:.1em;
  text-transform:uppercase; padding-top:2px}
.pd .kv dd{color:var(--ink-2); font-weight:500}

/* ══════════ GLANCE ══════════ */
.pd .glance{display:grid; grid-template-columns:repeat(4,1fr); gap:3.5mm}
.pd .gt{border:1px solid var(--rule-soft); border-radius:14px; padding:4mm 4.2mm;
  background:linear-gradient(180deg,#fff,var(--ivory))}
.pd .gt .gl2{font-size:6pt; letter-spacing:.2em; text-transform:uppercase; color:var(--faint);
  margin-bottom:4px}
.pd .gt .gv2{font-size:12.5pt; font-weight:700; color:var(--ink)}
.pd .gt .gs{font-size:6.6pt; letter-spacing:.07em; text-transform:uppercase; color:var(--faint); margin-top:3px}
.pd .gt.hi{background:linear-gradient(170deg,#FEFAF0,var(--champagne)); border-color:var(--gold-lite)}
.pd .gt.hi .gl2{color:var(--gold-deep)}
.pd .gt.hi .gv2{font-size:12.5pt; font-weight:700; color:var(--gold-deep)}
.pd .gt.hi .gs{color:var(--gold)}

/* ══════════ LINE-ITEM BLOCKS ══════════ */
.pd .fn{border:1px solid var(--rule-soft); border-radius:18px; overflow:hidden; margin-bottom:3.5mm;
  background:#fff}
.pd .fn-bar{display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;
  background:linear-gradient(100deg,var(--champagne) 0%,#FFFCF4 72%);
  padding:4mm 5.5mm; border-bottom:1px solid var(--rule)}
.pd .fn-name{font-family:var(--serif); font-size:15pt; font-weight:700; letter-spacing:.03em; color:var(--ink)}
.pd .fn-name em{font-style:normal; color:var(--gold-deep); font-size:9.5pt; letter-spacing:.13em;
  text-transform:uppercase; margin-left:8px}
.pd .fn-meta{display:flex; gap:4px; flex-wrap:wrap}
.pd .mchip{background:#fff; border:1px solid var(--rule); border-radius:999px; padding:3px 10px;
  font-size:6.9pt; color:var(--gold-deep); font-weight:600; letter-spacing:.05em; white-space:nowrap}
.pd .mchip.solid{background:linear-gradient(135deg,var(--gold-lite),var(--gold));
  border-color:var(--gold); color:#fff; text-shadow:0 1px 1px rgba(120,95,25,.35)}

.pd table{width:100%; border-collapse:collapse}
.pd th{font-size:6.4pt; letter-spacing:.2em; text-transform:uppercase; color:var(--soft);
  font-weight:700; text-align:left; padding:3mm 5.5mm 2.2mm; background:var(--ivory);
  border-bottom:1px solid var(--rule-soft)}
.pd th.n,.pd td.n{text-align:right}
.pd th.c,.pd td.c{text-align:center}
.pd td{padding:2.9mm 5.5mm; border-bottom:1px solid #F2EDE0; vertical-align:top; font-size:9.4pt}
.pd .it-name{font-weight:600; color:var(--ink); display:block}
.pd .it-desc{font-size:7.7pt; color:var(--soft); display:block; margin-top:2px; line-height:1.45}
.pd .dates{font-weight:400; color:var(--soft); font-size:8pt}
.pd .calc{font-size:8pt; color:var(--soft); white-space:nowrap}
.pd .amt{font-weight:600; color:var(--ink); white-space:nowrap; font-size:9.6pt}
.pd .free{color:var(--gold-deep); font-weight:700; font-size:7.6pt; letter-spacing:.1em}

/* group + sub-total rows — gold, not black */
.pd .grp td{background:linear-gradient(90deg,var(--champagne-2),#FCF7EA);
  padding:2.4mm 5.5mm; border-bottom:1px solid var(--rule);
  border-top:1px solid var(--rule); position:relative}
.pd .grp td:first-child{box-shadow:inset 3px 0 0 var(--gold-lite)}
.pd .grp .gname{font-size:7.2pt; letter-spacing:.24em; text-transform:uppercase;
  font-weight:700; color:var(--gold-deep)}
.pd .grp .gnote{font-size:6.6pt; letter-spacing:.12em; text-transform:uppercase; color:var(--gold)}
.pd tr.subx td{background:var(--ivory); border-bottom:1px solid var(--rule-soft);
  padding:2.5mm 5.5mm}
.pd tr.subx .lbl{letter-spacing:.13em; text-transform:uppercase; font-size:6.8pt;
  color:var(--soft); font-weight:700}
.pd tr.subx .val{font-weight:600; color:var(--ink); font-size:9pt}
.pd tr.sub td{background:linear-gradient(90deg,#FFFCF4,var(--champagne) 72%);
  border-bottom:none; border-top:1px solid var(--rule); padding:3mm 5.5mm}
.pd tr.sub .lbl{letter-spacing:.14em; text-transform:uppercase; font-size:7.1pt;
  color:var(--gold-deep); font-weight:700}
.pd tr.sub .val{font-weight:700; color:var(--ink); font-size:10.2pt}

/* ══════════ MENU SNAPSHOT ══════════ */
.pd .menu-body{padding:3.8mm 5mm 3.4mm}
.pd .menu-grid{display:grid; grid-template-columns:repeat(3,1fr); gap:3.6mm}
.pd .seg{border:1px solid var(--rule-soft); border-radius:12px; overflow:hidden;
  background:linear-gradient(180deg,#fff,var(--ivory)); break-inside:avoid}
.pd .seg-h{display:flex; justify-content:space-between; align-items:baseline; gap:6px;
  padding:2.3mm 3.2mm; background:var(--champagne); border-bottom:1px solid var(--rule-soft)}
.pd .seg-n{font-size:6.7pt; letter-spacing:.16em; text-transform:uppercase; font-weight:700;
  color:var(--gold-deep)}
.pd .seg-c{font-size:6.1pt; letter-spacing:.1em; color:var(--gold); white-space:nowrap; font-weight:600}
.pd .dishes{list-style:none; padding:2.2mm 3mm 2.4mm}
.pd .dishes li{font-size:8pt; line-height:1.36; color:var(--ink-2); padding-left:11px;
  position:relative; margin-bottom:.85mm}
.pd .dishes li:last-child{margin-bottom:0}
.pd .dishes li::before{content:""; position:absolute; left:0; top:5px; width:4px; height:4px;
  transform:rotate(45deg); border-radius:.5px; background:var(--gold-lite)}
.pd .dishes li.x{color:var(--ink); font-weight:500}
.pd .dishes li.x em{font-style:normal; font-size:5.8pt; letter-spacing:.12em; text-transform:uppercase;
  color:#fff; background:linear-gradient(135deg,var(--gold-lite),var(--gold));
  border-radius:999px; padding:1px 5px; margin-left:5px}
.pd .menu-note{margin-top:2.6mm; padding-top:2.2mm; border-top:1px solid var(--rule-soft);
  font-size:7.2pt; color:var(--soft); line-height:1.45}
.pd .menu-note b{color:var(--gold-deep); font-weight:700}

.pd .note{border:1px solid var(--rule); border-radius:14px; margin-top:2.6mm;
  background:linear-gradient(100deg,var(--champagne),#FFFCF4); padding:2.8mm 4.4mm;
  font-size:8pt; color:var(--ink-2); line-height:1.42}
.pd .note b{color:var(--gold-deep); font-weight:700}

/* ══════════ STATEMENT OF CHARGES ══════════ */
.pd .summary{border:1px solid var(--rule-soft); border-radius:18px; overflow:hidden;
  background:linear-gradient(180deg,#fff,var(--ivory))}
.pd .sum-in{padding:4mm 5mm 3.8mm}
.pd .sum-h{font-size:6.4pt; letter-spacing:.28em; text-transform:uppercase; color:var(--gold-deep);
  font-weight:700; margin-bottom:3mm}
.pd .sledger{max-width:none}
.pd .sline{display:flex; justify-content:space-between; align-items:baseline; gap:14px;
  padding:1.3mm 0; border-bottom:1px dotted var(--rule-soft); font-size:8.7pt}
.pd .sline .l{color:var(--ink-2)}
.pd .sline .l small{color:var(--faint); font-size:7.2pt; margin-left:6px}
.pd .sline .v{font-weight:600; color:var(--ink); white-space:nowrap}
.pd .sline.tax .v{color:var(--gold-deep)}
.pd .trow{display:flex; justify-content:space-between; align-items:baseline; gap:14px;
  margin-top:2mm; padding:2.2mm 0; border-top:1px solid var(--gold-lite);
  border-bottom:1px solid var(--gold-lite)}
.pd .trow .tl{font-size:7.4pt; letter-spacing:.24em; text-transform:uppercase; font-weight:700;
  color:var(--gold-deep)}
.pd .trow .tv{font-size:13.5pt; font-weight:700; color:var(--ink); white-space:nowrap}
.pd .words{margin-top:2.2mm; font-family:var(--serif); font-size:8.8pt; font-style:italic;
  color:var(--soft); line-height:1.3}
.pd .adv{margin-top:2.6mm; display:grid; grid-template-columns:1fr 1fr; gap:3.5mm}
.pd .adv-box{border:1px solid var(--rule-soft); border-radius:11px; padding:2.2mm 3.2mm; background:#fff}
.pd .adv-box.hi{border-color:var(--gold-lite); background:linear-gradient(160deg,#FEFAF0,var(--champagne))}
.pd .adv-box .al{font-size:6.2pt; letter-spacing:.2em; text-transform:uppercase; color:var(--faint);
  margin-bottom:2px}
.pd .adv-box.hi .al{color:var(--gold-deep)}
.pd .adv-box .av{font-size:10.5pt; font-weight:700; color:var(--ink)}
.pd .adv-box.hi .av{color:var(--gold-deep)}

/* ══════════ PANELS ══════════ */
.pd .two{display:grid; grid-template-columns:1fr 1fr; gap:5mm}
.pd .panel{border:1px solid var(--rule-soft); border-radius:16px; padding:3.4mm 4.4mm;
  background:linear-gradient(180deg,var(--ivory),#fff 60%)}
.pd .panel h4{font-size:6.6pt; letter-spacing:.24em; text-transform:uppercase; color:var(--gold-deep);
  font-weight:700; margin-bottom:2mm}
.pd .panel ul{list-style:none}
.pd .panel li{position:relative; padding-left:13px; font-size:7.9pt; line-height:1.34;
  color:var(--ink-2); margin-bottom:1.1mm}
.pd .panel li::before{content:""; position:absolute; left:0; top:5.5px; width:5px; height:5px;
  transform:rotate(45deg); border-radius:1px;
  background:linear-gradient(135deg,var(--gold-lite),var(--gold-deep))}
.pd .panel li b{color:var(--ink); font-weight:600}

.pd .pay{display:grid; grid-template-columns:repeat(3,1fr); gap:3.5mm}
.pd .pstep{border:1px solid var(--rule-soft); border-radius:14px; overflow:hidden; background:#fff}
.pd .pstep .ph{background:linear-gradient(100deg,var(--champagne),#FFFCF4); padding:2.2mm 3.6mm;
  border-bottom:1px solid var(--rule); font-size:6.4pt; letter-spacing:.2em;
  text-transform:uppercase; color:var(--gold-deep); font-weight:700}
.pd .pstep .pb{padding:2.2mm 3.4mm}
.pd .pstep .pct{font-family:var(--serif); font-size:15pt; font-weight:700; color:var(--gold-deep); line-height:1}
.pd .pstep .pamt{font-size:9.6pt; font-weight:700; color:var(--ink); margin-top:2px}
.pd .pstep .pwhen{font-size:7pt; color:var(--soft); margin-top:2px; line-height:1.28}

.pd .bank{display:grid; grid-template-columns:1.15fr .95fr .85fr 1.1fr .8fr;
  border:1px solid var(--rule-soft); border-radius:14px; overflow:hidden; margin-top:3mm}
.pd .bank>div{padding:2.4mm 3.4mm; border-right:1px solid var(--rule-soft);
  background:linear-gradient(180deg,#fff,var(--ivory))}
.pd .bank>div:last-child{border-right:none}
.pd .bank .bl{font-size:5.9pt; letter-spacing:.11em; text-transform:uppercase; color:var(--faint);
  margin-bottom:2px; white-space:nowrap}
.pd .bank .bv{font-size:8.2pt; font-weight:600; color:var(--ink); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; min-height:11pt}

.pd .sign{display:grid; grid-template-columns:1fr 1fr; gap:14mm; margin-top:2mm}
.pd .sig .line{border-bottom:1px solid var(--gold); height:8mm}
.pd .sig .who{font-size:7.1pt; letter-spacing:.18em; text-transform:uppercase; color:var(--gold-deep);
  margin-top:1.8mm; font-weight:700}
.pd .sig .sub{font-size:7.4pt; color:var(--soft); margin-top:1px}

.pd .footer{margin-top:1.2mm; border-top:1px solid var(--rule); background:var(--ivory);
  padding:2.4mm 16mm; font-size:6.9pt; letter-spacing:.04em; color:var(--soft);
  display:flex; justify-content:space-between; align-items:baseline; gap:14px; flex-wrap:nowrap;
  white-space:nowrap}
.pd .footer .thanks{font-family:var(--serif); font-size:10.5pt; font-style:italic; color:var(--gold-deep)}

/* ══════════ REPEATING PAGE FRAME (thead/tfoot repeat on every printed page) ══════════ */
.pd table.sheet{width:100%; border-collapse:collapse}
.pd table.sheet>thead>tr>td, .pd table.sheet>tfoot>tr>td, .pd table.sheet>tbody>tr>td{
  padding:0; border:none; background:transparent; font-size:inherit; vertical-align:top}
.pd .runfoot-rule{margin-top:3.5mm; height:1px;
  background:linear-gradient(90deg,rgba(230,216,175,0),var(--gold-lite) 22%,var(--gold-lite) 78%,rgba(230,216,175,0))}

/* ══════════ T&C ANNEXURE — facsimile of the client's PDF ══════════ */
.pd .tcpage{width:210mm; margin:14px auto 0; background:#fff; padding:12mm 11mm;
  box-shadow:0 18px 60px rgba(90,75,40,.22);
  font-family:'Times New Roman',Times,serif; color:#000; font-size:9pt; line-height:1.26}
.pd .tcbox{border:1.6px solid #000; padding:4mm 4.5mm 3mm; min-height:250mm;
  display:flex; flex-direction:column}
.pd .tcbox>.tcbody{flex:1}
.pd .tchead{text-align:center; margin-bottom:2mm}
.pd .tclogo{height:14mm; width:auto; margin:0 auto 1.2mm; display:block; mix-blend-mode:multiply}
.pd .tcname{font-size:12.5pt; font-weight:700; letter-spacing:.01em}
.pd .tcaddr{font-size:8.3pt; font-weight:700}
.pd .tctitle{text-align:center; font-size:10pt; font-weight:700; margin:3mm 0 1.5mm}
.pd .tcintro{font-size:9pt; text-align:justify; margin-bottom:1mm}
.pd .tccl{margin-bottom:.5mm; break-inside:avoid; page-break-inside:avoid}
.pd .tcn{font-size:9pt; font-weight:700}
.pd .tccl ul{list-style:disc; margin:0 0 0 8mm; padding:0}
.pd .tccl li{font-size:9pt; text-align:justify; margin-bottom:.3mm; line-height:1.2}
.pd .tcaccept{margin-top:4mm}
.pd .tcah{font-size:9.5pt; font-weight:700}
.pd .tcaintro{font-size:9pt; margin-bottom:2.5mm}
.pd table.tcfields{width:100%; border-collapse:collapse; margin-left:4mm}
.pd table.tcfields td{border:none; background:none; padding:1.3mm 0; font-size:10pt;
  vertical-align:baseline}
.pd .tcfl{font-weight:700; width:58mm; white-space:nowrap}
.pd .tcfc{width:6mm; font-weight:700}
.pd .tcfv{letter-spacing:.02em}
.pd .tcfoot{margin-top:3mm}
.pd .tcsigs{display:flex; justify-content:space-between; padding:0 12mm; font-weight:700;
  font-size:10pt; text-align:center}
.pd .tcsigs span{display:block}
.pd .tcpageno{text-align:center; font-size:9.5pt; margin-top:4mm}

@media print{
  .pd{background:#fff; padding:0}
  /* margin:0 hands the margins to the document instead of the browser. Two things follow:
     the gilt bar and masthead run to the sheet edge as the template draws them, and Chrome
     is left no margin box to print its URL / date / page-number strip into. (The print
     dialog's "Headers and footers" tick-box is still the authoritative switch — the toolbar
     above says so.) Every measurement below is therefore the real printed margin. */
  @page{size:A4; margin:0}
  .pd .page,.pd .tcpage{box-shadow:none; margin:0; width:auto}
  .pd .pad{padding:0 13mm}
  .pd .masthead{padding:9mm 13mm 6mm}
  .pd .footer{padding:3mm 13mm 9mm}
  /* The gilt bar and the closing rule repeat on every sheet; these keep the type off them
     and off the paper edge, on page four as much as on page one. */
  .pd table.sheet>thead>tr>td{padding-bottom:7mm}
  .pd table.sheet>tfoot>tr>td{padding-bottom:10mm}
  .pd .avoid,.pd .fn,.pd .card,.pd .cards,.pd .summary,.pd .panel,.pd .pstep,.pd .bank,
  .pd .sign,.pd .pay,.pd .two,.pd .glance,.pd .note,.pd .footer,.pd .seg,
  .pd .fn table,.pd .fn thead,.pd .fn tr{break-inside:avoid; page-break-inside:avoid}
  .pd .pill-row,.pd .fn-bar{break-after:avoid; page-break-after:avoid}
  .pd table.sheet,.pd table.sheet>tbody,.pd table.sheet>tbody>tr,.pd table.sheet>tbody>tr>td{
    break-inside:auto; page-break-inside:auto}
  /* The annexure is exactly two sheets. Each is given the height of one, so the box border
     closes on its own page instead of spilling its last centimetre onto a third — 295mm not
     297mm, because a hair of slack is what stops sub-pixel rounding from doing exactly that.
     The box then fills that height, which is what pins each signature block to the bottom. */
  .pd .tcpage{break-before:page; page-break-before:always; break-inside:avoid;
    height:295mm; padding:10mm}
  .pd .tcbox{height:100%; min-height:0}
  .pd *{-webkit-print-color-adjust:exact !important; print-color-adjust:exact !important}
}
`
