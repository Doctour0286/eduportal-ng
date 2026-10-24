import {
  EMPTY_OBLIGATION_DRAFT,
  type ObligationDraft,
  type ObligationKind,
} from '../services/obligationsService'

/**
 * Optional "fine or task" block shown inside the reactivation forms
 * (Students → Status tab, Attendance → suspended list). `value === null`
 * means no fine/task; the checkbox toggles it on with an empty draft.
 */
export default function ObligationFields({
  value,
  onChange,
  disabled,
}: {
  value: ObligationDraft | null
  onChange: (next: ObligationDraft | null) => void
  disabled?: boolean
}) {
  return (
    <div className="obl-fields">
      <label className="obl-toggle">
        <input
          type="checkbox"
          checked={value !== null}
          disabled={disabled}
          onChange={e => onChange(e.target.checked ? { ...EMPTY_OBLIGATION_DRAFT } : null)}
        />
        <span>Add a fine or task for this student</span>
      </label>

      {value && (
        <div className="obl-form">
          <div className="obl-row">
            <select
              className="obl-input"
              value={value.kind}
              disabled={disabled}
              onChange={e => onChange({ ...value, kind: e.target.value as ObligationKind })}
              aria-label="Fine or task"
            >
              <option value="fine">Fine</option>
              <option value="task">Task</option>
            </select>
            {value.kind === 'fine' && (
              <input
                className="obl-input obl-input--amount"
                type="text"
                inputMode="decimal"
                value={value.amount}
                disabled={disabled}
                onChange={e => onChange({ ...value, amount: e.target.value.replace(/[^0-9.]/g, '') })}
                placeholder="Amount (₦)"
                aria-label="Fine amount"
              />
            )}
            <input
              className="obl-input"
              type="date"
              value={value.dueDate}
              disabled={disabled}
              onChange={e => onChange({ ...value, dueDate: e.target.value })}
              aria-label="Due date (optional)"
              title="Due date (optional)"
            />
          </div>
          <input
            className="obl-input obl-input--wide"
            type="text"
            value={value.description}
            disabled={disabled}
            onChange={e => onChange({ ...value, description: e.target.value })}
            placeholder={value.kind === 'fine' ? 'Reason for the fine' : 'What must the student do?'}
            aria-label="Description"
          />
        </div>
      )}
    </div>
  )
}
