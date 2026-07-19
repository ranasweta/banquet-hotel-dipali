import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { InvoicePrint } from '@/components/invoice-print'

export default async function ProformaPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'bookings' && p.action === 'view')) redirect('/')
  const { id } = await params
  return <InvoicePrint eventId={id} proforma />
}
