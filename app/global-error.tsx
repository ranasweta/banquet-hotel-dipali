'use client'

/**
 * The last-resort error screen.
 *
 * `app/(app)/error.tsx` catches what a PAGE throws, but not what its own layout throws —
 * and `(app)/layout.tsx` loads the signed-in user, so a database hiccup there fails above
 * every boundary in the group. Without this file that lands on Next's built-in page: a
 * black screen reading "A server error occurred" over a numeric digest, which is what a
 * member of the hotel's staff was shown on their phone.
 *
 * It replaces the root layout when it renders, so it brings its own <html>/<body> and
 * cannot rely on the fonts or the Tailwind layer being applied. Hence plain inline styles
 * in the brand's cream and gold — this screen must not have a dependency that can itself
 * be the thing that broke. The digest is printed because it is the only handle support has
 * on the matching server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
          background: '#F7F0E0',
          color: '#13130F',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <main
          style={{
            maxWidth: '28rem',
            width: '100%',
            textAlign: 'center',
            background: '#FFFCF5',
            border: '1px solid #E0D3B4',
            borderRadius: '0.75rem',
            padding: '2rem',
          }}
        >
          <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600, color: '#8E7230' }}>
            Hotel Dipali
          </h1>
          <p style={{ margin: '1rem 0 0', fontSize: '1rem', fontWeight: 600 }}>
            This screen could not be loaded
          </p>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.875rem', color: '#655D48' }}>
            The problem is at our end, not with anything you did. Nothing you had entered has
            been submitted. Please try again.
          </p>
          <div
            style={{
              marginTop: '1.5rem',
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={reset}
              style={{
                cursor: 'pointer',
                border: '1px solid #8E7230',
                background: '#8E7230',
                color: '#FFFCF5',
                borderRadius: '0.5rem',
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}
            >
              Try again
            </button>
            <button
              onClick={() => {
                window.location.href = '/'
              }}
              style={{
                cursor: 'pointer',
                border: '1px solid #E0D3B4',
                background: 'transparent',
                color: '#13130F',
                borderRadius: '0.5rem',
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}
            >
              Dashboard
            </button>
          </div>
          {error.digest ? (
            <p style={{ margin: '1.5rem 0 0', fontSize: '0.75rem', color: '#655D48' }}>
              Quote this to support: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  )
}
