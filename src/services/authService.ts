/**
 * authService.ts
 * Business logic for all three login methods.
 * No browser-only APIs. No UI imports.
 * React Native compatible.
 */

import { supabase } from '../lib/supabase'

export type LoginMethod = 'email_password' | 'phone_otp' | 'login_code'

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

// ─── Phone OTP (guardian) ─────────────────────────────────────────────────

export async function sendPhoneOtp(phone: string): Promise<AuthResult> {
  // Normalise Nigerian numbers: ensure E.164 format (+234...)
  const normalised = normaliseNigerianPhone(phone)
  if (!normalised) {
    return { ok: false, error: 'Enter a valid Nigerian phone number (e.g. 0812 345 6789)' }
  }
  const { error } = await supabase.auth.signInWithOtp({ phone: normalised })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function verifyPhoneOtp(
  phone: string,
  token: string,
): Promise<AuthResult> {
  const normalised = normaliseNigerianPhone(phone)
  if (!normalised) return { ok: false, error: 'Invalid phone number' }
  const { error } = await supabase.auth.verifyOtp({
    phone: normalised,
    token,
    type: 'sms',
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

function normaliseNigerianPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('0')) {
    return '+234' + digits.slice(1)
  }
  if (digits.length === 10) {
    return '+234' + digits
  }
  if (digits.length === 13 && digits.startsWith('234')) {
    return '+' + digits
  }
  return null
}

// ─── Login code (student + guardian) ──────────────────────────────────────
// Handled by the `login-with-code` Edge Function using the service-role key
// server-side. The client sends the code + school_id; the Edge Function
// mints the session and returns tokens. The service-role key NEVER appears here.

export async function loginWithCode(
  schoolId: string,
  code: string,
): Promise<AuthResult> {
  const { data, error } = await supabase.functions.invoke('login-with-code', {
    body: { school_id: schoolId, login_code: code },
  })
  if (error || !data?.access_token) {
    return { ok: false, error: data?.error ?? 'Invalid login code' }
  }
  // Set the session using the tokens returned by the Edge Function
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  })
  if (sessionError) return { ok: false, error: sessionError.message }
  return { ok: true }
}

// ─── Sign out ─────────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}
