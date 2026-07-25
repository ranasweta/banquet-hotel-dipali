'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { api } from '@/lib/http'

/**
 * Staff sign-in. On lg+ the property sits on the left and the form on the right; on a phone
 * the same photograph moves behind the form under a dark scrim, so the one screen every user
 * meets is never a bare form on a flat background.
 *
 * A missing photo must not leave a broken frame, so both the left panel and the mobile
 * backdrop fail back to the brand gradient wash.
 *
 * Underlined inputs rather than boxes, to match the approved design. That gives up the
 * outline WCAG 1.4.11 usually leans on to identify a field, so each one keeps a visible
 * label and a 2px focus underline in the brand gold — never identified by placeholder alone.
 */
export default function LoginPage() {
  const router = useRouter()
  const [mobile, setMobile] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ mobile, password }) })
      router.replace('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh">
      {/* Property side. Hidden below lg: on a phone it would push the form off-screen. */}
      <div className="relative hidden w-1/2 overflow-hidden bg-secondary lg:block">
        {/* The wash sits underneath as the loading colour and the fallback, so the panel is
            never a white rectangle while a 1.9 MB photograph decodes. */}
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--sidebar-primary)] via-secondary to-[var(--primary)]" />
        <Image
          src="/hotel-dipali-property.png"
          alt=""
          fill
          priority
          sizes="50vw"
          // The source is square and the panel is a tall half-screen, so it crops hard.
          // Anchored low: the pools and the lit lawn are the bottom two-thirds of the frame,
          // and centring would throw away the half worth looking at.
          className="object-cover object-bottom"
          onError={(e) => {
            // Reveal the wash beneath rather than a broken frame.
            e.currentTarget.style.display = 'none'
          }}
        />
        {/* Deep enough to keep the wordmark legible against the pool lights underneath. */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/40 to-transparent p-10">
          <p className="font-[family-name:var(--font-serif)] text-3xl font-semibold text-white">
            Hotel Dipali
          </p>
          <p className="mt-1 text-sm uppercase tracking-[0.14em] text-white/85">
            Sagar · Madhya Pradesh
          </p>
        </div>
      </div>

      {/* Form side. On a phone the property photo sits behind under a scrim; on lg+ the left
          panel carries the imagery and this side is a plain surface. */}
      <div className="relative flex w-full items-center justify-center overflow-hidden bg-background p-6 lg:w-1/2">
        {/* Mobile-only backdrop: the same property photo, darkened so the card and its labels
            stay legible. Hidden at lg, where the left panel already shows it. */}
        <div className="absolute inset-0 lg:hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[var(--sidebar-primary)] via-secondary to-[var(--primary)]" />
          <Image
            src="/hotel-dipali-property.png"
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover object-bottom"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
          <div className="absolute inset-0 bg-black/55" />
        </div>
        <div className="relative w-full max-w-md rounded-xl border bg-card/95 p-8 shadow-xl backdrop-blur-sm sm:p-10 lg:bg-card lg:shadow-sm lg:backdrop-blur-none">
          <div className="flex flex-col items-center text-center">
            <Image
              src="/hotel-dipali-logo.png"
              alt="Hotel Dipali"
              width={160}
              height={160}
              priority
              // The logo ships on a white background rather than transparent; multiply drops
              // that white into the card instead of showing a box around the mark.
              className="h-20 w-auto mix-blend-multiply"
            />
            <h1 className="mt-5 font-[family-name:var(--font-serif)] text-3xl font-semibold text-primary">
              Hotel Dipali
            </h1>
            <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Concierge Portal — Staff Sign In
            </p>
          </div>

          <form onSubmit={onSubmit} className="mt-8 space-y-6">
            <Field
              id="mobile"
              label="Mobile number"
              value={mobile}
              onChange={setMobile}
              placeholder="e.g. 9000000001"
              type="tel"
              autoComplete="username"
              autoFocus
            />

            <Field
              id="password"
              label="Password"
              value={password}
              onChange={setPassword}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                </button>
              }
            />

            {error && (
              <p role="alert" aria-live="polite" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-[13px] font-semibold uppercase tracking-[0.1em] text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}

/** An underlined field. The label stays visible — a placeholder is not a label. */
function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
  autoFocus,
  trailing,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
  trailing?: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
      >
        {label}
      </label>
      <div className="mt-1 flex items-center gap-1 border-b-2 border-input focus-within:border-primary">
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required
          inputMode={type === 'tel' ? 'numeric' : undefined}
          className="min-h-11 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground/60"
        />
        {trailing}
      </div>
    </div>
  )
}
