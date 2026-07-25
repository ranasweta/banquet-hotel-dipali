'use client'

import { useEffect, useState } from 'react'
import { Loader2, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import {
  HOTEL,
  TERMS_ACCEPTANCE,
  TERMS_CLAUSES,
  TERMS_INTRO,
  TERMS_TITLE,
} from '@/lib/terms'

/**
 * The printable proposal — a designed A4 document, proposal first and the Terms & Conditions
 * annexure after it, fed by the same figures as the on-screen estimate.
 *
 * TERMINOLOGY (client, 20 Jul 2026): the words "invoice" and "final" must never reach the
 * guest. There are exactly two documents a guest sees — **Draft** (an enquiry's provisional
 * estimate) and **Draft 2** (a confirmed booking's proposal). Both print with their name as a
 * diagonal watermark on every page (client, 25 Jul 2026). File and table names keep the old
 * wording internally; only what a human reads changes.
 *
 * Printing: Chrome/Edge → Ctrl/Cmd+P → Save as PDF, A4, "Background graphics" on. The scoped
 * print rules below set the A4 page size, professional margins and the page break before the
 * annexure, so a saved PDF matches the on-screen document.
 */

type Line = { id: string; section: string; description: string; functionLabel: string | null; qty: string; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number }
type PrintData = {
  event: { code: string; guestName: string; eventType: string; status: string; firstDate: string | null; lastDate: string | null } | null
  contacts: { phone: string; label: string | null }[]
  invoice: {
    invoiceNo: string | null; finalised: boolean
    grossPaise: number; discountPaise: number; taxPaise: number; netPaise: number; advancesPaise: number; balancePaise: number
    tncSnapshot: string; lines: Line[]
    payments: { id: string; kind: string; amountPaise: number; mode: string; receiptNo: string; receivedOn: string }[]
  }
}

const SECTIONS = [
  { key: 'venue', label: 'Venue hire' },
  { key: 'food', label: 'Food & beverage' },
  { key: 'rooms', label: 'Rooms & lodging' },
  { key: 'maintenance', label: 'Maintenance & extras' },
  { key: 'adjustment', label: 'Adjustments' },
] as const

type Group = { key: string; label: string; lines: Line[]; subtotalPaise: number; taxPaise: number }

export function InvoicePrint({ eventId, proforma = false }: { eventId: string; proforma?: boolean }) {
  const [data, setData] = useState<PrintData | null>(null)

  useEffect(() => {
    api<PrintData>(proforma ? `/events/${eventId}/proforma` : `/events/${eventId}/invoice/print`)
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [eventId, proforma])

  if (!data) return <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  const inv = data.invoice
  const ev = data.event

  // Draft vs Draft 2. For a live estimate it follows the booking's stage — an enquiry is a
  // Draft, a confirmed (or later) booking is a Draft 2. For the drafted bill it follows
  // finalisation. Either way the guest only ever reads "Draft" or "Draft 2".
  const isDraft2 = proforma ? Boolean(ev && ev.status !== 'enquiry') : inv.finalised
  const docName = isDraft2 ? 'DRAFT 2' : 'DRAFT'

  // Grouped the way the hotel counts a proposal: each function with its own venue and food
  // beneath it, then the event-level heads (rooms span several functions; maintenance and
  // adjustments are event-wide), each keeping its section heading.
  const sum = (ls: Line[], f: (l: Line) => number) => ls.reduce((n, l) => n + f(l), 0)

  const functionNames: string[] = []
  for (const l of inv.lines) {
    if (l.functionLabel && !functionNames.includes(l.functionLabel)) functionNames.push(l.functionLabel)
  }
  const functionGroups: Group[] = functionNames.map((name) => {
    const lines = inv.lines.filter((l) => l.functionLabel === name)
    return { key: `fn:${name}`, label: name, lines, subtotalPaise: sum(lines, (l) => l.amountPaise), taxPaise: sum(lines, (l) => l.taxPaise) }
  })
  const eventLevel: Group[] = SECTIONS.map((sec) => {
    const lines = inv.lines.filter((l) => !l.functionLabel && l.section === sec.key)
    return { key: sec.key, label: sec.label, lines, subtotalPaise: sum(lines, (l) => l.amountPaise), taxPaise: sum(lines, (l) => l.taxPaise) }
  }).filter((g) => g.lines.length > 0)
  const groups = [...functionGroups, ...eventLevel]

  const issued = ev?.firstDate ?? null
  const advance25 = Math.round(inv.netPaise * 0.25)
  const dateRange = ev?.firstDate
    ? `${ev.firstDate}${ev.lastDate && ev.lastDate !== ev.firstDate ? ` → ${ev.lastDate}` : ''}`
    : '—'

  return (
    <div className="mx-auto max-w-4xl p-2">
      {/* Toolbar — never printed. */}
      <div className="mb-3 flex items-center justify-between print:hidden">
        <p className="text-sm text-muted-foreground">
          Press Print, then <span className="font-medium text-foreground">Save as PDF</span> (A4, background graphics on).
        </p>
        <Button variant="outline" onClick={() => window.print()}><Printer className="size-4" /> Print</Button>
      </div>

      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="pd">
        <div className="wm" aria-hidden><span>{docName}</span></div>
        <div className="gild" />

        <div className="body">
          {/* ── Masthead ── */}
          <div className="mast">
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/hotel-dipali-logo.png" alt="Hotel Dipali" className="mast-logo" />
              <div className="mast-sub">{HOTEL.name}</div>
            </div>
            <div className="doc-side">
              <div className="doc-kicker">Banquet Proposal</div>
              <div className="doc-title">Proposal</div>
              <div className="chips">
                <div className="chip stamp"><span>Status</span><b>{docName}</b></div>
                <div className="chip"><span>Booking</span><b>{ev?.code ?? '—'}</b></div>
                {issued && <div className="chip"><span>Issued</span><b>{issued}</b></div>}
                {inv.invoiceNo && <div className="chip"><span>No.</span><b>{inv.invoiceNo}</b></div>}
              </div>
            </div>
          </div>
          <div className="contact">
            <span><i>◆</i>{HOTEL.address}</span>
            <span><i>◆</i>{HOTEL.phone}</span>
            <span><i>◆</i>{HOTEL.email}</span>
            <span><i>◆</i>GSTIN {HOTEL.gstin}</span>
            <span><i>◆</i>FSSAI {HOTEL.fssai}</span>
          </div>

          {/* ── Guest + event ── */}
          <div className="pill-row"><div className="pill"><span className="gem" />Prepared for</div><div className="hair" /></div>
          <div className="cards">
            <div className="card">
              <div className="card-label">Guest</div>
              <div className="card-name">{ev?.guestName ?? '—'}</div>
              {data.contacts.map((c) => (
                <div key={c.phone} className="kv"><dt>Contact</dt><dd className="tabnum">{c.phone}{c.label ? ` · ${c.label}` : ''}</dd></div>
              ))}
            </div>
            <div className="card warm">
              <div className="card-label">Event</div>
              <div className="card-name capitalize">{ev?.eventType.replace(/_/g, ' ') ?? '—'}</div>
              <div className="kv"><dt>Dates</dt><dd className="tabnum">{dateRange}</dd></div>
              <div className="kv"><dt>Booking</dt><dd className="tabnum">{ev?.code ?? '—'}</dd></div>
            </div>
          </div>

          {/* ── Statement of charges ── */}
          <div className="pill-row"><div className="pill"><span className="gem" />Statement of Charges</div><div className="hair" /><div className="tag">All figures in ₹</div></div>
          <table className="ctable">
            <thead>
              <tr>
                <th>Description</th>
                <th className="n">How it works out</th>
                <th className="n">Amount</th>
                <th className="n">Tax</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => <ChargeGroup key={g.key} group={g} />)}
            </tbody>
          </table>

          {/* ── Totals ── */}
          <div className="sum">
            <div className="sline"><span className="l">Sub-total</span><span className="v">{formatPaise(inv.grossPaise)}</span></div>
            {inv.discountPaise > 0 && <div className="sline"><span className="l">Less discounts</span><span className="v">− {formatPaise(inv.discountPaise)}</span></div>}
            <div className="sline tax"><span className="l">Tax <small>5% on accommodation only</small></span><span className="v">+ {formatPaise(inv.taxPaise)}</span></div>
            <div className="trow"><span className="tl">Amount payable</span><span className="tv">{formatPaise(inv.netPaise)}</span></div>
            {inv.advancesPaise > 0 && (
              <>
                <div className="sline"><span className="l">Received so far</span><span className="v">− {formatPaise(inv.advancesPaise)}</span></div>
                {inv.payments?.map((p) => (
                  <div key={p.id} className="sline instal">
                    <span className="l">{p.receivedOn} · {p.mode} · {p.receiptNo}</span>
                    <span className="v">{p.kind === 'refund' ? '+' : '−'} {formatPaise(Math.abs(p.amountPaise))}</span>
                  </div>
                ))}
                <div className="trow"><span className="tl">Balance due</span><span className="tv">{formatPaise(inv.balancePaise)}</span></div>
              </>
            )}
          </div>

          {/* ── Payment schedule ── */}
          <div className="pill-row"><div className="pill"><span className="gem" />Payment Schedule</div><div className="hair" /></div>
          <div className="pay">
            <div className="pstep">
              <div className="ph">Advance · to confirm</div>
              <div className="pb"><div className="pct">25%</div><div className="pamt">{formatPaise(advance25)}</div><div className="pwhen">On receipt the venue windows are held and the booking is confirmed.</div></div>
            </div>
            <div className="pstep">
              <div className="ph">Balance · before the event</div>
              <div className="pb"><div className="pct">75%</div><div className="pamt">{formatPaise(inv.netPaise - advance25)}</div><div className="pwhen">Payable in full at least 30 days before the event. Cheques subject to realisation.</div></div>
            </div>
            <div className="pstep">
              <div className="ph">Extras · before checkout</div>
              <div className="pb"><div className="pct" style={{ fontSize: '15px' }}>On actuals</div><div className="pamt">Before final checkout</div><div className="pwhen">Additional charges incurred during the event, settled against Draft 2.</div></div>
            </div>
          </div>

          {/* ── Inclusions ── */}
          <div className="pill-row"><div className="pill"><span className="gem" />Inclusions &amp; Notes</div><div className="hair" /><div className="tag">What this estimate covers</div></div>
          <div className="two">
            <div className="panel">
              <h4>Included in this estimate</h4>
              <ul>
                <li><b>Venue</b> — exclusive hold on the function spaces above.</li>
                <li><b>Food</b> — the tier and guaranteed pax priced per function.</li>
                <li><b>Rooms</b> — the room-nights listed under Rooms &amp; lodging.</li>
                <li><b>Room tax</b> — 5%, on the accommodation head only.</li>
              </ul>
            </div>
            <div className="panel">
              <h4>Not included / billed on actuals</h4>
              <ul>
                <li><b>Maintenance entries</b> — post-event extras, added once logged.</li>
                <li><b>Menu extras</b> — two per function free; further extras chargeable on approval.</li>
                <li><b>Extra pax</b> beyond the guaranteed count, at the same rate.</li>
                <li><b>Décor, lighting, stage, sound, LED, DJ</b> — charged separately (Annexure cl. 9).</li>
              </ul>
            </div>
          </div>

          <div className="note">
            <b>Terms &amp; Conditions.</b> The Terms and Conditions for Banquet Booking annexure follows
            this estimate and forms an integral part of it. Payment of the advance or written acceptance
            constitutes acceptance of those Terms — please sign and return both.
          </div>

          <div className="sign">
            <div className="sig"><div className="line" /><div className="who">Accepted by the Guest</div><div className="sub">Name, signature &amp; date</div></div>
            <div className="sig"><div className="line" /><div className="who">For {HOTEL.name}</div><div className="sub">Authorised Signatory</div></div>
          </div>

          <div className="foot">
            <span className="thanks">We look forward to hosting your celebration.</span>
            <span>{HOTEL.name} · {HOTEL.phone} · Proposal {ev?.code ?? '—'} · {docName === 'DRAFT 2' ? 'Draft 2' : 'Draft'}</span>
          </div>
        </div>

        {/* ══════════ TERMS & CONDITIONS ANNEXURE ══════════ */}
        <div className="body terms-page">
          <div className="terms-head">
            <div className="th-title">{TERMS_TITLE}</div>
            <div className="th-sub">{HOTEL.name} · GSTIN {HOTEL.gstin} · FSSAI {HOTEL.fssai}</div>
          </div>
          <p className="terms-intro">{TERMS_INTRO}</p>
          <ol className="terms">
            {TERMS_CLAUSES.map((c) => (
              <li key={c.title}><b>{c.title}.</b> {c.body}</li>
            ))}
          </ol>

          <div className="accept">
            <div className="ac-h">Client Acceptance</div>
            <p className="ac-intro">{TERMS_ACCEPTANCE}</p>
            <div className="ac-field"><span className="ac-l">Name of Client / Organisation</span><span className="ac-line" /></div>
            <div className="ac-field"><span className="ac-l">Event Name / Type</span><span className="ac-line" /></div>
            <div className="ac-field"><span className="ac-l">Event Date</span><span className="ac-line" /></div>
            <div className="ac-field"><span className="ac-l">Date</span><span className="ac-line" /></div>
            <div className="ac-field"><span className="ac-l">Place</span><span className="ac-val">{HOTEL.name.replace(' Sagar', '')}, Sagar</span></div>
          </div>

          <div className="sign">
            <div className="sig"><div className="line" /><div className="who">Client Signature</div></div>
            <div className="sig"><div className="line" /><div className="who">Authorised Signatory · {HOTEL.name}</div></div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** One charge head: its lines, then its own sub-total. */
function ChargeGroup({ group }: { group: Group }) {
  return (
    <>
      <tr className="grow"><td colSpan={4}>{group.label}</td></tr>
      {group.lines.map((l) => {
        const qty = Number(l.qty)
        return (
          <tr key={l.id} className="irow">
            <td>{l.description}</td>
            <td className="n calc">{qty > 1 ? `${qty} × ${formatPaise(l.ratePaise)}` : formatPaise(l.ratePaise)}</td>
            <td className="n amt">{formatPaise(l.amountPaise)}</td>
            <td className="n calc">{l.gstRateBp > 0 ? `${formatPaise(l.taxPaise)} (${(l.gstRateBp / 100).toFixed(0)}%)` : '—'}</td>
          </tr>
        )
      })}
      <tr className="srow">
        <td colSpan={2} className="n">{group.label} sub-total</td>
        <td className="n">{formatPaise(group.subtotalPaise)}</td>
        <td className="n">{group.taxPaise > 0 ? formatPaise(group.taxPaise) : '—'}</td>
      </tr>
    </>
  )
}

/**
 * The document's design, scoped to `.pd` so it never leaks into the app shell. Colours and
 * type follow the approved proposal template (Cormorant Garamond display over the app sans).
 * The diagonal watermark is `position: fixed` so it repeats on every printed page, and
 * `print-color-adjust: exact` keeps the gilt bar, chips and watermark on paper.
 */
const CSS = `
.pd{--ink:#2A2620;--ink2:#4A443B;--soft:#7C7466;--faint:#A79E8C;--gold-deep:#8C6E1F;--gold:#B8912F;--gold-mid:#C9A227;--gold-lite:#DFC276;--champagne:#FBF5E6;--champagne2:#F6EDD8;--ivory:#FFFDF7;--rule:#E6D8AF;--rule-soft:#EFE7D4;--serif:var(--font-serif),'Cormorant Garamond',Georgia,'Times New Roman',serif;position:relative;max-width:210mm;margin:0 auto;background:#fff;color:var(--ink);font-variant-numeric:tabular-nums;box-shadow:0 18px 60px rgba(90,75,40,.16);overflow:hidden}
.pd .tabnum{font-variant-numeric:tabular-nums}
.pd .gild{height:4px;background:linear-gradient(90deg,var(--gold-deep),var(--gold-lite) 18%,#FBF0D2 34%,var(--gold-mid) 50%,#FBF0D2 66%,var(--gold-lite) 82%,var(--gold-deep))}
.pd .body{padding:11mm 14mm 12mm;position:relative;z-index:1}
.pd .mast{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;padding-bottom:6mm;border-bottom:1px solid var(--rule)}
.pd .mast-logo{height:20mm;width:auto;display:block;mix-blend-mode:multiply}
.pd .mast-sub{font-size:8px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold-deep);margin-top:6px;font-weight:600}
.pd .doc-side{text-align:right}
.pd .doc-kicker{font-size:8px;letter-spacing:.34em;text-transform:uppercase;color:var(--soft)}
.pd .doc-title{font-family:var(--serif);font-size:36px;font-weight:600;letter-spacing:.05em;color:var(--gold-deep);line-height:1;margin:2px 0 7px}
.pd .chips{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.pd .chip{border:1px solid var(--rule);border-radius:999px;padding:4px 11px;font-size:9px;white-space:nowrap;background:var(--champagne)}
.pd .chip span{color:var(--faint);text-transform:uppercase;letter-spacing:.13em;font-size:8px;margin-right:5px}
.pd .chip b{color:var(--gold-deep);font-weight:700}
.pd .chip.stamp{background:linear-gradient(135deg,#F6EAC9,#EFDFB4);border-color:var(--gold-lite)}
.pd .chip.stamp b{color:#7A5E15}
.pd .contact{display:flex;gap:14px;flex-wrap:wrap;margin-top:5mm;font-size:9.5px;color:var(--soft)}
.pd .contact i{color:var(--gold);font-style:normal;margin-right:5px;font-size:7px;vertical-align:middle}
.pd .pill-row{display:flex;align-items:center;gap:11px;margin:8mm 0 3.5mm}
.pd .pill{display:inline-flex;align-items:center;gap:9px;background:linear-gradient(180deg,#FEFAF0,var(--champagne2));border:1px solid var(--rule);color:var(--gold-deep);border-radius:999px;padding:7px 18px 7px 13px;font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase}
.pd .pill .gem{width:8px;height:8px;transform:rotate(45deg);border-radius:1.5px;background:linear-gradient(135deg,var(--gold-lite),var(--gold-deep))}
.pd .pill-row .hair{flex:1;height:1px;background:linear-gradient(90deg,var(--gold-lite),rgba(223,194,118,0))}
.pd .pill-row .tag{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);white-space:nowrap}
.pd .cards{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
.pd .card{border:1px solid var(--rule-soft);border-radius:16px;padding:5mm;background:linear-gradient(180deg,var(--ivory),#fff 70%)}
.pd .card.warm{background:linear-gradient(170deg,#FDF7E9,var(--champagne));border-color:var(--rule)}
.pd .card-label{font-size:8px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-deep);font-weight:700;margin-bottom:7px}
.pd .card-name{font-family:var(--serif);font-size:22px;font-weight:600;line-height:1.1;color:var(--ink);margin-bottom:7px}
.pd .kv{display:flex;gap:8px;font-size:11px;line-height:1.7;margin:0}
.pd .kv dt{width:58px;flex:none;color:var(--faint);font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px;margin:0}
.pd .kv dd{color:var(--ink2);font-weight:500;margin:0}
.pd .ctable{width:100%;border-collapse:collapse}
.pd .ctable th{font-size:8px;letter-spacing:.18em;text-transform:uppercase;color:var(--soft);font-weight:700;text-align:left;padding:3mm 4mm 2mm;background:var(--ivory);border-bottom:1px solid var(--rule-soft)}
.pd .ctable th.n,.pd .ctable td.n{text-align:right}
.pd .ctable td{padding:2.6mm 4mm;border-bottom:1px solid #F2EDE0;vertical-align:top;font-size:12px}
.pd .grow td{background:linear-gradient(90deg,var(--champagne2),#FCF7EA);border-bottom:1px solid var(--rule);border-top:1px solid var(--rule);font-size:9px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:var(--gold-deep);box-shadow:inset 3px 0 0 var(--gold-lite)}
.pd .irow .calc{font-size:10px;color:var(--soft);white-space:nowrap}
.pd .irow .amt{font-weight:600;color:var(--ink);white-space:nowrap}
.pd .srow td{border-bottom:1px solid var(--rule);font-weight:600;color:var(--ink2);font-size:11px;background:#FFFCF4}
.pd .sum{margin:5mm 0 0;margin-left:auto;max-width:92mm;border:1px solid var(--rule-soft);border-radius:14px;background:linear-gradient(180deg,#fff,var(--ivory));padding:4mm 5mm}
.pd .sline{display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:1.4mm 0;border-bottom:1px dotted var(--rule-soft);font-size:11.5px}
.pd .sline .l{color:var(--ink2)}
.pd .sline .l small{color:var(--faint);font-size:9px;margin-left:5px}
.pd .sline .v{font-weight:600;color:var(--ink);white-space:nowrap}
.pd .sline.tax .v{color:var(--gold-deep)}
.pd .sline.instal{padding-left:6mm;font-size:9.5px;color:var(--soft);border-bottom:none}
.pd .sline.instal .v{font-weight:500;color:var(--soft)}
.pd .trow{display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-top:2mm;padding:2.4mm 0;border-top:1px solid var(--gold-lite);border-bottom:1px solid var(--gold-lite)}
.pd .trow .tl{font-size:9px;letter-spacing:.22em;text-transform:uppercase;font-weight:700;color:var(--gold-deep)}
.pd .trow .tv{font-size:17px;font-weight:700;color:var(--ink);white-space:nowrap}
.pd .pay{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}
.pd .pstep{border:1px solid var(--rule-soft);border-radius:14px;overflow:hidden;background:#fff}
.pd .pstep .ph{background:linear-gradient(100deg,var(--champagne),#FFFCF4);padding:2.4mm 3.6mm;border-bottom:1px solid var(--rule);font-size:8px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold-deep);font-weight:700}
.pd .pstep .pb{padding:2.6mm 3.6mm}
.pd .pstep .pct{font-family:var(--serif);font-size:19px;font-weight:700;color:var(--gold-deep);line-height:1}
.pd .pstep .pamt{font-size:12px;font-weight:700;color:var(--ink);margin-top:3px}
.pd .pstep .pwhen{font-size:9px;color:var(--soft);margin-top:3px;line-height:1.3}
.pd .two{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
.pd .panel{border:1px solid var(--rule-soft);border-radius:16px;padding:4mm 5mm;background:linear-gradient(180deg,var(--ivory),#fff 60%)}
.pd .panel h4{font-size:8px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold-deep);font-weight:700;margin:0 0 2.5mm}
.pd .panel ul{list-style:none;margin:0;padding:0}
.pd .panel li{position:relative;padding-left:13px;font-size:11px;line-height:1.4;color:var(--ink2);margin-bottom:1.4mm}
.pd .panel li:before{content:"";position:absolute;left:0;top:6px;width:5px;height:5px;transform:rotate(45deg);border-radius:1px;background:linear-gradient(135deg,var(--gold-lite),var(--gold-deep))}
.pd .panel li b{color:var(--ink);font-weight:600}
.pd .note{border:1px solid var(--rule);border-radius:14px;margin-top:5mm;background:linear-gradient(100deg,var(--champagne),#FFFCF4);padding:3.4mm 4.4mm;font-size:11px;color:var(--ink2);line-height:1.45}
.pd .note b{color:var(--gold-deep);font-weight:700}
.pd .sign{display:grid;grid-template-columns:1fr 1fr;gap:16mm;margin-top:9mm}
.pd .sig .line{border-bottom:1px solid var(--gold);height:9mm}
.pd .sig .who{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-deep);margin-top:2mm;font-weight:700}
.pd .sig .sub{font-size:10px;color:var(--soft);margin-top:1px}
.pd .foot{margin-top:9mm;border-top:1px solid var(--rule);padding-top:3mm;font-size:9px;letter-spacing:.03em;color:var(--soft);display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap}
.pd .foot .thanks{font-family:var(--serif);font-size:14px;font-style:italic;color:var(--gold-deep)}
.pd .terms-head{border-bottom:1px solid var(--rule);padding-bottom:3mm;margin-bottom:4mm}
.pd .terms-head .th-title{font-family:var(--serif);font-size:22px;font-weight:600;color:var(--gold-deep)}
.pd .terms-head .th-sub{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--soft);margin-top:2px}
.pd .terms-intro{font-size:10.5px;color:var(--ink2);line-height:1.5;margin-bottom:3.5mm}
.pd ol.terms{counter-reset:t;list-style:none;columns:2;column-gap:9mm;margin:0;padding:0}
.pd ol.terms li{counter-increment:t;position:relative;padding-left:18px;font-size:9.5px;line-height:1.42;color:var(--ink2);margin-bottom:2mm;break-inside:avoid}
.pd ol.terms li b{color:var(--ink);font-weight:700}
.pd ol.terms li:before{content:counter(t,decimal-leading-zero);position:absolute;left:0;top:0;font-size:9px;font-weight:700;color:var(--gold)}
.pd .accept{margin-top:5mm;border:1px solid var(--rule-soft);border-radius:14px;background:linear-gradient(180deg,var(--ivory),#fff 60%);padding:4mm 5mm}
.pd .accept .ac-h{font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold-deep);font-weight:700;margin-bottom:2mm}
.pd .accept .ac-intro{font-size:10px;color:var(--ink2);line-height:1.45;margin-bottom:3mm}
.pd .ac-field{display:flex;align-items:baseline;gap:8px;margin-bottom:3mm}
.pd .ac-field .ac-l{font-size:10px;color:var(--ink2);width:56mm;flex:none}
.pd .ac-field .ac-line{flex:1;border-bottom:1px dotted var(--faint);height:5mm}
.pd .ac-field .ac-val{flex:1;font-size:11px;color:var(--ink);font-weight:500}
.pd .wm{position:absolute;inset:0;z-index:0;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden}
.pd .wm span{transform:rotate(-28deg);white-space:nowrap;font-size:150px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:rgba(140,110,31,.06)}
@media print{
  .pd{box-shadow:none;max-width:none;margin:0;overflow:visible}
  @page{size:A4;margin:12mm}
  .pd .body{padding:0}
  .pd .terms-page{break-before:page;page-break-before:always;padding-top:2mm}
  .pd .wm{position:fixed}
  .pd .card,.pd .pstep,.pd .panel,.pd .sig,.pd .grow,.pd .srow,.pd .note,.pd .trow,.pd .accept,.pd ol.terms li{break-inside:avoid;page-break-inside:avoid}
  .pd .pill-row{break-after:avoid;page-break-after:avoid}
  .pd *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}
}
`
