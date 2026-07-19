/**
 * remitaPortalService.ts
 * Student-self-service Remita payment triggers for the Guardian/Student portal.
 *
 * Deliberately its own file, not folded into either existing service:
 *   - portalService.ts is explicitly documented as read-only by design —
 *     every function there is a direct supabase.from(...).select(...), and
 *     that "nothing here changes state" property is one future maintainers
 *     will reasonably rely on. These two functions trigger real money
 *     movement (indirectly, via an Edge Function), which would silently
 *     break that property if added there.
 *   - financeService.ts's functions assume a staff/admin caller (gated by
 *     finance.fees.manage / finance.payments.record permissions server-side).
 *     These two functions are the opposite: callable ONLY by the student
 *     themselves (remita-initiate-payment rejects anyone whose resolved
 *     identity isn't actor_type = 'student'), matching the owner's locked
 *     "self-service only" decision (master plan §12). Mixing them into
 *     financeService.ts would make every future reader have to remember
 *     "except these two."
 *
 * This file does no direct writes itself — both functions call a Supabase
 * Edge Function (which does its own service-role-scoped writes server-side,
 * after independently re-verifying with Remita). supabase.functions.invoke()
 * automatically forwards the caller's own auth header, so the Edge Function
 * resolves identity via getUser() exactly as it does for every other caller.
 *
 * No browser-only APIs — React Native safe per §5.1.
 */

import { supabase } from '../lib/supabase'

export interface InitiatePaymentResult {
  rrr: string
  orderId: string
  amount: number
  paymentPageUrl: string
}

export interface VerifyPaymentResult {
  status: 'pending' | 'completed' | 'failed'
  alreadyResolved?: boolean
}

/**
 * Kicks off a real Remita RRR for one or more of the student's own unpaid
 * fee_assignment rows. Never send an amount here — the Edge Function
 * re-derives it server-side from the real fee_assignments rows, exactly
 * like every other write path in this codebase never trusts a client-sent
 * amount.
 *
 * Throws on any failure (network, validation, or Remita-side) — callers
 * should wrap this in their own try/catch and show a friendly message,
 * matching the pattern GuardianPortal's other tabs already use for their
 * own load functions.
 */
export async function initiateFeesPayment(
  feeAssignmentIds: string[]
): Promise<InitiatePaymentResult> {
  if (!feeAssignmentIds.length) {
    throw new Error('No fee assignments selected.')
  }

  const { data, error } = await supabase.functions.invoke('remita-initiate-payment', {
    body: { fee_assignment_ids: feeAssignmentIds },
  })

  if (error) {
    throw new Error(error.message ?? 'Could not start payment. Please try again.')
  }
  if (!data?.ok) {
    throw new Error(data?.error ?? 'Could not start payment. Please try again.')
  }

  return {
    rrr: data.rrr,
    orderId: data.orderId,
    amount: data.amount,
    paymentPageUrl: data.paymentPageUrl,
  }
}

/**
 * Re-triggers server-side verification for a given RRR — the same action
 * whether the student just returned from an online payment page, or is
 * checking on a bank-teller/USSD payment made earlier (Remita's own status
 * endpoint is polling-based, not push-only, per master plan §12's research
 * note). The Edge Function always independently re-queries Remita's own
 * status.reg endpoint; nothing here is trusted client-side.
 */
export async function checkPaymentStatus(rrr: string): Promise<VerifyPaymentResult> {
  const { data, error } = await supabase.functions.invoke('remita-verify-payment', {
    body: { rrr },
  })

  if (error) {
    throw new Error(error.message ?? 'Could not check payment status. Please try again.')
  }
  if (!data?.ok) {
    throw new Error(data?.error ?? 'Could not check payment status. Please try again.')
  }

  return {
    status: data.status,
    alreadyResolved: data.alreadyResolved,
  }
}
