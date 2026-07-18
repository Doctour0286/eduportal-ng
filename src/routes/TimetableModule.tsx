/**
 * TimetableModule.tsx
 * SESSION 68 — thin dispatcher, mirroring ResultsModule.tsx's SESSION 60 /
 * AttendanceModule.tsx's SESSION 66 dispatcher-split precedent exactly:
 * schoolType decides which of two entirely separate components renders —
 * TimetableModuleSecondary (the pre-existing period/class-grid module,
 * renamed verbatim, not rewritten) for a secondary school, or the new
 * TimetableModuleHigherEd (course-offering time-range grid) for a
 * higher-institution school. Never threaded further than this one branch
 * point — each component owns its own internal rendering entirely, per
 * §3.16's "school_type read exactly once" rule.
 *
 * isHigherEdSchool() is this file's own local copy of the same check every
 * other route-branch site in this codebase already duplicates locally
 * (App.tsx's own TabContent copy, ResultsModule.tsx, CourseAttendanceModule.tsx,
 * CourseRegistrationModule.tsx) — not imported from a shared module, per
 * those files' own recorded "worth promoting to lib/schoolType.ts, out of
 * scope here" precedent, which this file follows rather than breaks.
 */

import TimetableModuleSecondary from './TimetableModuleSecondary'
import TimetableModuleHigherEd from './TimetableModuleHigherEd'

function isHigherEdSchool(schoolType: string | null | undefined): boolean {
  return !!schoolType && ['university', 'polytechnic', 'college_of_education', 'other'].includes(schoolType)
}

interface TimetableModuleProps {
  schoolId: string
  schoolName: string
  isAdmin: boolean
  schoolType: string | null
  currentStaffId?: string | null
  /** Current student's own students.id — set only when actorType ===
   *  'student' and the identity has resolved. Passed straight through to
   *  TimetableModuleHigherEd; TimetableModuleSecondary does not take this
   *  prop at all (its own file's guardian/student handling lives entirely
   *  in App.tsx's route branch above the 'timetable' tab, not in the
   *  component itself), so it is not forwarded there. */
  currentStudentId?: string | null
}

export default function TimetableModule({
  schoolId,
  schoolName,
  isAdmin,
  schoolType,
  currentStaffId = null,
  currentStudentId = null,
}: TimetableModuleProps) {
  if (isHigherEdSchool(schoolType)) {
    return (
      <TimetableModuleHigherEd
        schoolId={schoolId}
        isAdmin={isAdmin}
        currentStaffId={currentStaffId}
        currentStudentId={currentStudentId}
      />
    )
  }

  return (
    <TimetableModuleSecondary
      schoolId={schoolId}
      schoolName={schoolName}
      isAdmin={isAdmin}
      currentStaffId={currentStaffId}
    />
  )
}
