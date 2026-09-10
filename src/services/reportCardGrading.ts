/**
 * reportCardGrading.ts
 * Small, pure grading-lookup helpers shared by BOTH report card renderers
 * (reportCardPdf.ts's jsPDF path, and reportCardHtml.ts's browser-print
 * path — see reportCardHtml.ts's own file header for why a second
 * renderer exists). Extracted here specifically so the two renderers can
 * never drift on what a given grade/average means — same lookup, same
 * remark text, same ordinal formatting, regardless of which one produces
 * the final document.
 */

export interface GradeBandLike {
  min_score: number
  max_score: number
  grade_label: string
  remark: string | null
}

export function getGradeRemark(gradeLabel: string | null, bands: GradeBandLike[]): string | null {
  if (!gradeLabel) return null
  const band = bands.find(b => b.grade_label === gradeLabel)
  return band?.remark ?? null
}

export function getAvgGradeLabel(avg: number, bands: GradeBandLike[]): string | null {
  const band = bands.find(b => avg >= b.min_score && avg <= b.max_score)
  return band?.grade_label ?? null
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
