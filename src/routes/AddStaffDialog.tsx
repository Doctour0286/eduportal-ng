import { useEffect, useState } from 'react'
import { Modal } from '../components/Modal'
import { createStaffMember, getRoles } from '../services/onboardingService'
import { NAME_PREFIXES, composeName } from '../lib/namePrefix'

/**
 * Add a staff member from the HR module. Uses the same account-creation
 * function as the setup wizard, so the person gets a real login — but without
 * sending an administrator back through the wizard (whose other steps can
 * change school-wide settings).
 */
export default function AddStaffDialog({
  open,
  schoolId,
  onClose,
  onAdded,
}: {
  open: boolean
  schoolId: string
  onClose: () => void
  onAdded: () => void | Promise<void>
}) {
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([])
  const [prefix, setPrefix] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [hireDate, setHireDate] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ name: string; email: string; password?: string } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => { if (open) void getRoles(schoolId).then(setRoles) }, [open, schoolId])

  function reset() {
    setPrefix(''); setFullName(''); setEmail(''); setPhone(''); setHireDate(''); setRoleIds([])
    setError(''); setCreated(null); setCopied(false)
  }
  useEffect(() => { if (open) reset() }, [open])

  async function submit() {
    if (!fullName.trim()) { setError('Enter the staff member’s full name.'); return }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('Enter a valid email address.'); return }
    setSaving(true); setError('')
    const name = composeName(prefix, fullName)
    const res = await createStaffMember(schoolId, {
      full_name: name,
      email: email.trim(),
      phone: phone.trim() || undefined,
      hire_date: hireDate || undefined,
      role_ids: roleIds,
    })
    setSaving(false)
    if (!res.ok) { setError(res.error ?? 'Could not create the account.'); return }
    setCreated({ name, email: email.trim(), password: res.tempPassword })
    await onAdded()
  }

  async function copy() {
    if (!created?.password) return
    try { await navigator.clipboard.writeText(created.password); setCopied(true) } catch { /* ignore */ }
  }

  return (
    <Modal open={open} onClose={onClose} title={created ? 'Staff member added' : 'Add staff member'} showTitle maxWidth="480px">
      {created ? (
        <div className="fma">
          <p className="fma-notice">{created.name} now has an account.</p>
          {created.password ? (
            <>
              <p className="fma-hint">Give them this temporary password with their email ({created.email}). It is shown only now, and they should change it after their first sign-in.</p>
              <div className="ast-pass"><code>{created.password}</code><button type="button" className="obl-btn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></div>
            </>
          ) : (
            <p className="fma-hint">They can sign in with {created.email}.</p>
          )}
          <div className="fma-actions">
            <button type="button" className="obl-btn obl-btn--primary" onClick={reset}>Add another</button>
            <button type="button" className="obl-btn" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <div className="fma">
          <div className="ast-name">
            <label className="fma-reason">Prefix
              <select className="fma-input" value={prefix} onChange={e => setPrefix(e.target.value)}>
                <option value="">None</option>
                {NAME_PREFIXES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="fma-reason">Full name
              <input className="fma-input" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="e.g. Aisha Ibrahim" />
            </label>
          </div>
          <label className="fma-reason">Email address
            <input className="fma-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <div className="ast-name">
            <label className="fma-reason">Phone (optional)
              <input className="fma-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} />
            </label>
            <label className="fma-reason">Hire date (optional)
              <input className="fma-input" type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} />
            </label>
          </div>
          <fieldset className="fma-group">
            <legend>Role{roles.length === 1 ? '' : 's'}</legend>
            {roles.length === 0 ? <p className="fma-hint">No roles exist yet. Create roles in Settings first.</p> : roles.map(r => (
              <label key={r.id}>
                <input type="checkbox" checked={roleIds.includes(r.id)}
                  onChange={e => setRoleIds(prev => e.target.checked ? [...prev, r.id] : prev.filter(x => x !== r.id))} /> {r.name}
              </label>
            ))}
          </fieldset>
          {roleIds.length === 0 && <p className="fma-hint">With no role the person can sign in but won’t be able to do anything until you give them one.</p>}
          {error && <p className="fma-error" role="alert">{error}</p>}
          <div className="fma-actions">
            <button type="button" className="obl-btn obl-btn--primary" disabled={saving} onClick={() => void submit()}>{saving ? 'Creating…' : 'Create account'}</button>
            <button type="button" className="obl-btn" disabled={saving} onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
