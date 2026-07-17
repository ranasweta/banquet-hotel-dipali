import 'server-only'
import { getIronSession, type IronSession } from 'iron-session'
import { cookies } from 'next/headers'

/**
 * The session cookie holds ONLY the user id — deliberately not the role or permissions.
 * `requirePermission` reads `role_permissions` fresh on every request, so an Admin's
 * change to the matrix takes effect on the user's next request without a re-login
 * (M1 acceptance criterion). Caching permissions in the cookie would break that.
 */
export interface SessionData {
  userId?: string
}

function sessionPassword(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET must be set and at least 32 characters. See .env.example for how to generate one.',
    )
  }
  return secret
}

/** 8 hours. FR-8.2 wants this configurable; a settings-backed override can come later. */
const SESSION_TTL_SECONDS = 8 * 60 * 60

export async function getSession(): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(await cookies(), {
    password: sessionPassword(),
    cookieName: 'dipali_session',
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
  })
}
