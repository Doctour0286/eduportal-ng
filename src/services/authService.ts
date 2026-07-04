/**
 * authService.ts
 * Business logic for login methods.
 * No browser-only APIs. No UI imports.
 * React Native compatible.
 *
 * Supported methods:
 *   - Staff: email + password
 *   - Guardian / Student: login code (issued by school admin)
 *
 * Phone OTP removed — requires Twilio configuration that is not yet set up.
 * Re-add sendPhoneOtp / verifyPhoneOtp here when Twilio is connected.
 */

import { supabase } from '../lib/supabase'

export type LoginMethod = 'email_password' | 'login_code'

export interface AuthResult {
  ok: boolean
  error?: string
}

// ─── Email + password (staff) ──────────────────────────────────────────────

export async function loginWithEmail(
  email: string,
  password: string,
): Promise<AuthResult> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ─── Login code (guardian + student) ─────────────────────────────────────
// Handled by the `login-with-code` Edge Function using the service-role key
// server-side. The service-role key NEVER appears here.
//
// Flow:
//   1. POST to Edge Function with school_id + login_code
//   2. Edge Function looks up identity, calls admin.generateLink({ type:'magiclink' })
//      and returns { hashed_token }  ← new in this version
//   3. We call supabase.auth.verifyOtp({ token_hash, type:'magiclink' }) to
//      exchange the token for a real session — official Supabase v2 pattern.
//      No email is ever sent; we consume the token directly.

export async function loginWithCode(
  schoolId: string,
  code: string,
): Promise<AuthResult> {
  // import.meta.env is typed by vite/client — use it directly rather than
  // casting through Record<string, unknown>, which TS rejects because
  // ImportMeta has no index signature.
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
  const ANON_KEY     = import.meta.env.VITE_SUPABASE_ANON_KEY as string

  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/login-with-code`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${ANON_KEY}`,
        'apikey':        ANON_KEY,
      },
      body: JSON.stringify({
        school_id:  schoolId,
        login_code: code.trim().toUpperCase(),
      }),
    })
  } catch {
    return { ok: false, error: 'Network error — check your connection and try again' }
  }

  let body: Record<string, string>
  try { body = await res.json() } catch { body = {} }

  if (!res.ok) {
    return { ok: false, error: body?.error ?? 'Invalid login code' }
  }

  // ── Exchange hashed_token for a real session ──────────────────────────────
  const { hashed_token } = body
  if (!hashed_token) {
    return { ok: false, error: 'Login failed — no token returned. Contact your school admin.' }
  }

  const { error: otpError } = await supabase.auth.verifyOtp({
    token_hash: hashed_token,
    type: 'magiclink',
  })
  if (otpError) return { ok: false, error: otpError.message }

  return { ok: true }
}

// ─── Sign out ─────────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}
