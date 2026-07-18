'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 text-center">
      <AlertTriangle className="size-8 text-amber-500" />
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        This screen hit an unexpected error. You can retry, or head back to the dashboard.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => (window.location.href = '/')}>Dashboard</Button>
      </div>
    </div>
  )
}
