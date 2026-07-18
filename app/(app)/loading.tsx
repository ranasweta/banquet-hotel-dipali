import { Loader2 } from 'lucide-react'

export default function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
    </div>
  )
}
