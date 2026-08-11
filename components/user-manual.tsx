'use client'

import { useState } from 'react'
import Image from 'next/image'
import { MANUAL, type RoleGuide } from '@/lib/manual'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The manual, opened at the reader's own role.
 *
 * Every role's guide is reachable, not just the reader's: the Admin who sets an account up
 * and the GM who is phoned about a shortfall both need to know what the other side sees.
 */
export function UserManual({ roleName }: { roleName: string }) {
  const [active, setActive] = useState<RoleGuide>(
    MANUAL.find((g) => g.role === roleName) ?? MANUAL[0]!,
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {MANUAL.map((g) => (
          <Button
            key={g.role}
            size="sm"
            variant={g.role === active.role ? 'secondary' : 'outline'}
            onClick={() => setActive(g)}
          >
            {g.label}
            {g.role === roleName ? <span className="text-muted-foreground">· you</span> : null}
          </Button>
        ))}
      </div>

      <p className="max-w-2xl text-muted-foreground">{active.summary}</p>

      <div className="space-y-8">
        {active.sections.map((section) => (
          <section key={section.heading} className="space-y-3">
            <div className="border-b pb-2">
              <h2 className="text-lg font-semibold">{section.heading}</h2>
              {section.where ? (
                <p className="text-xs text-muted-foreground">{section.where}</p>
              ) : null}
            </div>
            <ol className="space-y-4">
              {section.steps.map((step) => (
                <li key={step.title} className="space-y-1">
                  <h3 className="font-medium">{step.title}</h3>
                  <p className="max-w-2xl text-sm text-muted-foreground">{step.body}</p>
                  {step.note ? (
                    <p
                      className={cn(
                        'max-w-2xl rounded-md border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm',
                        'text-amber-900 dark:border-amber-600 dark:bg-amber-950/30 dark:text-amber-200',
                      )}
                    >
                      {step.note}
                    </p>
                  ) : null}
                  {/* The screen itself. Unoptimised on purpose — these are already-sized PNGs
                      of the app, and routing them through the image optimiser costs a
                      transform per screenshot for no gain. `h-auto` keeps the aspect ratio
                      once `w-full` has scaled it down on a narrow window. */}
                  {step.image ? (
                    <Image
                      src={step.image.src}
                      alt={step.image.alt}
                      width={step.image.width}
                      height={step.image.height}
                      unoptimized
                      className="mt-2 h-auto w-full max-w-2xl rounded-lg border shadow-sm"
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  )
}
