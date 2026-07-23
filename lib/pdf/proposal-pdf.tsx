import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'
import { formatPaise } from '@/lib/money'

/**
 * The downloadable proposal PDF (tester, 23 Jul 2026). It renders the SAME data the on-screen
 * "Draft" uses (GET /events/:id/proforma), so every figure matches the app to the paisa — this
 * file only re-expresses that data in @react-pdf primitives. Generated client-side on demand.
 */

type Line = {
  id: string
  section: string
  description: string
  functionLabel: string | null
  qty: string
  ratePaise: number
  gstRateBp: number
  amountPaise: number
  taxPaise: number
}

export type ProposalPdfData = {
  event: { code: string; guestName: string; eventType: string; firstDate: string | null; lastDate: string | null } | null
  contacts: { phone: string; label: string | null }[]
  invoice: {
    grossPaise: number
    discountPaise: number
    taxPaise: number
    netPaise: number
    advancesPaise: number
    balancePaise: number
    tncSnapshot: string
    lines: Line[]
    payments: { id: string; kind: string; amountPaise: number; mode: string; receiptNo: string; receivedOn: string }[]
  }
}

// Event-level heads, in the order the hotel counts a proposal, matching invoice-print.tsx.
const SECTION_LABELS: Record<string, string> = {
  venue: 'Venue hire',
  food: 'Food & beverage',
  rooms: 'Rooms & lodging',
  maintenance: 'Maintenance & extras',
  adjustment: 'Adjustments',
}
const SECTION_ORDER = ['venue', 'food', 'rooms', 'maintenance', 'adjustment']

type Group = { key: string; label: string; lines: Line[]; subtotalPaise: number }

/** Group by function first (venue + food under each), then the event-wide heads. */
function buildGroups(lines: Line[]): Group[] {
  const sum = (ls: Line[], f: (l: Line) => number) => ls.reduce((n, l) => n + f(l), 0)
  const fnNames: string[] = []
  for (const l of lines) if (l.functionLabel && !fnNames.includes(l.functionLabel)) fnNames.push(l.functionLabel)
  const fnGroups = fnNames.map((name) => {
    const gl = lines.filter((l) => l.functionLabel === name)
    return { key: `fn:${name}`, label: name, lines: gl, subtotalPaise: sum(gl, (l) => l.amountPaise) }
  })
  const evGroups = SECTION_ORDER.map((sec) => {
    const gl = lines.filter((l) => !l.functionLabel && l.section === sec)
    return { key: sec, label: SECTION_LABELS[sec] ?? sec, lines: gl, subtotalPaise: sum(gl, (l) => l.amountPaise) }
  }).filter((g) => g.lines.length > 0)
  return [...fnGroups, ...evGroups]
}

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 48, paddingHorizontal: 44, fontSize: 9, color: '#1c1917', fontFamily: 'Helvetica' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: '#e7e5e4', paddingBottom: 10, marginBottom: 12 },
  hotel: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  muted: { color: '#78716c' },
  small: { fontSize: 8 },
  docTag: { fontSize: 12, fontFamily: 'Helvetica-Bold', letterSpacing: 1, textAlign: 'right' },
  note: { backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fcd34d', borderRadius: 4, padding: 7, marginBottom: 12, fontSize: 8, color: '#92400e' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  label: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#78716c', marginBottom: 2 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#d6d3d1', paddingBottom: 3, marginBottom: 2 },
  groupHead: { backgroundColor: '#f5f5f4', paddingVertical: 3, paddingHorizontal: 4, marginTop: 6, fontSize: 8, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: '#eeece9' },
  subRow: { flexDirection: 'row', paddingVertical: 3 },
  cDesc: { flex: 4 },
  cWorks: { flex: 3, textAlign: 'right', color: '#78716c', fontSize: 8 },
  cAmt: { flex: 2, textAlign: 'right' },
  cTax: { flex: 2, textAlign: 'right', color: '#78716c' },
  totals: { marginTop: 14, marginLeft: 'auto', width: 240 },
  totLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5 },
  totStrong: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderTopWidth: 1, borderTopColor: '#d6d3d1', marginTop: 2 },
  bold: { fontFamily: 'Helvetica-Bold' },
  tnc: { marginTop: 20, borderTopWidth: 1, borderTopColor: '#e7e5e4', paddingTop: 8, fontSize: 8, color: '#57534e' },
  signs: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 28 },
  sign: { width: '33%', borderTopWidth: 1, borderTopColor: '#d6d3d1', marginTop: 22, paddingTop: 3, marginRight: 0, fontSize: 8, color: '#78716c', textAlign: 'center' },
})

export function ProposalPdf({ data }: { data: ProposalPdfData }) {
  const inv = data.invoice
  const groups = buildGroups(inv.lines)
  const ev = data.event
  const dates = ev?.firstDate ? `${ev.firstDate}${ev.lastDate && ev.lastDate !== ev.firstDate ? ` → ${ev.lastDate}` : ''}` : ''

  return (
    <Document title={`Proposal ${ev?.code ?? ''}`}>
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.hotel}>Hotel Dipali</Text>
            <Text style={[styles.muted, styles.small]}>Near Makronia Railway Crossing, Jabalpur Road, Sagar</Text>
          </View>
          <View>
            <Text style={styles.docTag}>PROPOSAL — DRAFT</Text>
            {ev?.code ? <Text style={{ textAlign: 'right' }}>{ev.code}</Text> : null}
          </View>
        </View>

        <Text style={styles.note}>
          This is a provisional statement. Amounts can still change as rooms, maintenance and chef
          charges are recorded, and no document number has been issued yet.
        </Text>

        <View style={styles.metaRow}>
          <View>
            <Text style={styles.label}>BILLED TO</Text>
            <Text style={styles.bold}>{ev?.guestName ?? ''}</Text>
            {data.contacts.map((c) => (
              <Text key={c.phone} style={styles.muted}>
                {c.phone}
                {c.label ? ` · ${c.label}` : ''}
              </Text>
            ))}
          </View>
          <View>
            <Text style={[styles.label, { textAlign: 'right' }]}>EVENT</Text>
            <Text style={{ textAlign: 'right' }}>
              {ev?.code ?? ''} · {(ev?.eventType ?? '').replace(/_/g, ' ')}
            </Text>
            {dates ? <Text style={[styles.muted, { textAlign: 'right' }]}>{dates}</Text> : null}
          </View>
        </View>

        <View style={styles.tableHead}>
          <Text style={[styles.cDesc, styles.small, styles.muted]}>Description</Text>
          <Text style={[styles.cWorks, styles.small]}>How it works out</Text>
          <Text style={[styles.cAmt, styles.small, styles.muted]}>Amount</Text>
          <Text style={[styles.cTax, styles.small]}>Tax</Text>
        </View>

        {groups.map((g) => (
          <View key={g.key} wrap={false}>
            <Text style={styles.groupHead}>{g.label}</Text>
            {g.lines.map((l) => {
              const qty = Number(l.qty)
              return (
                <View key={l.id} style={styles.row}>
                  <Text style={styles.cDesc}>{l.description}</Text>
                  <Text style={styles.cWorks}>{qty > 1 ? `${qty} × ${formatPaise(l.ratePaise)}` : formatPaise(l.ratePaise)}</Text>
                  <Text style={styles.cAmt}>{formatPaise(l.amountPaise)}</Text>
                  <Text style={styles.cTax}>{l.gstRateBp > 0 ? `${formatPaise(l.taxPaise)} (${(l.gstRateBp / 100).toFixed(0)}%)` : '—'}</Text>
                </View>
              )
            })}
            <View style={styles.subRow}>
              <Text style={[styles.cDesc, styles.muted, styles.small]}>{g.label} sub-total</Text>
              <Text style={styles.cWorks}> </Text>
              <Text style={[styles.cAmt, styles.bold]}>{formatPaise(g.subtotalPaise)}</Text>
              <Text style={styles.cTax}> </Text>
            </View>
          </View>
        ))}

        <View style={styles.totals}>
          <View style={styles.totLine}>
            <Text style={styles.muted}>Sub-total</Text>
            <Text>{formatPaise(inv.grossPaise)}</Text>
          </View>
          {inv.discountPaise > 0 ? (
            <View style={styles.totLine}>
              <Text style={styles.muted}>Less discounts</Text>
              <Text>{`− ${formatPaise(inv.discountPaise)}`}</Text>
            </View>
          ) : null}
          <View style={styles.totLine}>
            <Text style={styles.muted}>Tax — 5% on rooms only</Text>
            <Text>{`+ ${formatPaise(inv.taxPaise)}`}</Text>
          </View>
          <View style={styles.totStrong}>
            <Text style={styles.bold}>Amount payable</Text>
            <Text style={styles.bold}>{formatPaise(inv.netPaise)}</Text>
          </View>
          <View style={styles.totLine}>
            <Text style={styles.muted}>Received so far</Text>
            <Text>{`− ${formatPaise(inv.advancesPaise)}`}</Text>
          </View>
          <View style={styles.totStrong}>
            <Text style={styles.bold}>Balance due</Text>
            <Text style={styles.bold}>{formatPaise(inv.balancePaise)}</Text>
          </View>
        </View>

        {inv.tncSnapshot ? (
          <View style={styles.tnc}>
            <Text style={[styles.bold, { color: '#1c1917', marginBottom: 3 }]}>Terms &amp; Conditions</Text>
            <Text>{inv.tncSnapshot}</Text>
          </View>
        ) : null}

        <View style={styles.signs}>
          {['Guest', 'Banquet Manager', 'Lodge Manager', 'Maintenance', 'Auditor'].map((r) => (
            <Text key={r} style={styles.sign}>
              {r}
            </Text>
          ))}
        </View>
      </Page>
    </Document>
  )
}
