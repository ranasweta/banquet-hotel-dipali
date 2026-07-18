import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 text-center">
      <div className="text-4xl font-bold text-muted-foreground">404</div>
      <h2 className="text-lg font-semibold">Not found</h2>
      <p className="text-sm text-muted-foreground">That page or record doesn’t exist, or you don’t have access to it.</p>
      <Link href="/" className={buttonVariants()}>Back to dashboard</Link>
    </div>
  )
}
