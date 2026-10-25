/**
 * Optional honorific for staff (and teacher) names.
 *
 * Staff accounts are created by an edge function that takes a single
 * full_name, and every screen in the app displays that one field. So the
 * prefix is stored as the leading part of full_name ("Mal. Ibrahim Musa")
 * and these helpers split/compose it for the forms. That way the prefix shows
 * everywhere a teacher's name does, with no per-screen changes.
 *
 * Only a fixed list is recognised when splitting, so a name that merely
 * starts with similar letters is never mangled.
 */
export const NAME_PREFIXES = [
  'Mr.', 'Mrs.', 'Miss', 'Ms.', 'Mal.', 'Alh.', 'Alhaja', 'Dr.', 'Prof.',
  'Engr.', 'Barr.', 'Rev.', 'Pastor', 'Chief', 'Sir', 'Madam',
] as const

export function splitNamePrefix(fullName: string): { prefix: string; name: string } {
  const trimmed = fullName.trim()
  for (const p of NAME_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(p.toLowerCase() + ' ')) {
      return { prefix: p, name: trimmed.slice(p.length).trim() }
    }
  }
  return { prefix: '', name: trimmed }
}

export function composeName(prefix: string, name: string): string {
  const n = name.trim()
  return prefix ? `${prefix} ${n}`.trim() : n
}
