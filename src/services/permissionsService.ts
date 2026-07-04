/**
 * permissionsService.ts
 * PRD Tier 3 / Problem 3.1 / Session 8. Admin-bypass added Session 9
 * follow-on (locked 2026-07-01, §12).
 *
 * Resolves a staff member's effective permission set, including class-level
 * scoping. Two layers, staff-level override always wins when present — see
 * MASTER_PROJECT_PLAN.md §7.3 (schema) and §12 (locked decision, 2026-07-01)
 * for the full design rationale.
 *
 * Resolution order per key, staff-first:
 *   1. staff_permission_class_scope has any row for this staff+key?
 *      -> GRANTED. Scope = that row set (or unrestricted if a class_id IS NULL
 *         row is present). Role is irrelevant once this fires — stop here.
 *      -> This layer can grant a key the staff member's role does NOT hold,
 *         by explicit owner decision (2026-07-01). It is an independent
 *         grant mechanism, not merely a scope-narrower on top of a role grant.
 *   2. No staff-level row -> does any of the staff's roles grant this key via
 *      role_permissions? -> GRANTED. Scope = role_permission_class_scope for
 *      that (role_id, permission_key) (or unrestricted if no scope row exists).
 *   3. Neither -> NOT granted.
 *
 * Admin bypass: `can()`/`canForClass()` take an optional `isAdminRole` param
 * (default false) that short-circuits to granted. `authStore.ts`'s `can`/
 * `canForClass` store methods must pass their already-resolved `isAdminRole`
 * through on every call so every call site in the app gets this for free —
 * see that file for the other half of this wiring (NOT YET DONE as of this
 * comment; this file's half is complete and self-contained).
 *
 * Platform-agnostic — no browser-only APIs. Safe for a future React Native port.
 */

import { supabase } from '../lib/supabase'

/**
 * null = unrestricted (school-wide). A Set of class ids = restricted to
 * exactly those classes. A key absent from the map at all = not granted.
 */
export type PermissionScopeMap = Map<string, Set<string> | null>

interface RolePermissionRow {
  permission_key: string
  role_id: string
}

interface RoleScopeRow {
  role_id: string
  permission_key: string
  class_id: string
}

interface StaffScopeRow {
  permission_key: string
  class_id: string | null
}

/**
 * loadEffectivePermissions
 * Returns the flat set of permission keys the staff member holds, unioned
 * across every source (all roles + any staff-level override grants).
 * Does not carry scope information — use loadEffectivePermissionScopes for
 * that. Kept separate because most call sites only need a boolean "can they
 * do this at all," and building the full scope map is unnecessary work for
 * them.
 */
export async function loadEffectivePermissions(staffId: string): Promise<Set<string>> {
  const scopes = await loadEffectivePermissionScopes(staffId)
  return new Set(scopes.keys())
}

/**
 * loadEffectivePermissionScopes
 * Returns a map of permission key -> scope (null = unrestricted, Set<string>
 * of class ids = restricted). Implements the staff-first resolution order
 * documented at the top of this file.
 *
 * Fails safe: any query error results in an empty map (no permissions),
 * never a thrown error that could leave calling code treating a failed
 * fetch as "no restrictions apply."
 */
export async function loadEffectivePermissionScopes(staffId: string): Promise<PermissionScopeMap> {
  const result: PermissionScopeMap = new Map()

  // Step 1: staff-level overrides. Presence of ANY row for a given
  // permission_key means this layer decides that key's grant + scope
  // entirely — role data for that key is never consulted afterward.
  const staffOverrideKeys = new Set<string>()
  try {
    const { data: staffRows, error: staffError } = await supabase
      .from('staff_permission_class_scope')
      .select('permission_key, class_id')
      .eq('staff_id', staffId)

    if (staffError) {
      // Fail safe: treat as "no staff overrides" rather than throwing.
      // Role-level resolution (step 2) still proceeds normally below.
    } else if (staffRows) {
      const byKey = new Map<string, StaffScopeRow[]>()
      for (const row of staffRows as StaffScopeRow[]) {
        const existing = byKey.get(row.permission_key) ?? []
        existing.push(row)
        byKey.set(row.permission_key, existing)
      }
      for (const [key, rows] of byKey) {
        staffOverrideKeys.add(key)
        const hasUnrestrictedRow = rows.some((r) => r.class_id === null)
        if (hasUnrestrictedRow) {
          result.set(key, null)
        } else {
          const classIds = rows.map((r) => r.class_id).filter((id): id is string => id !== null)
          result.set(key, new Set(classIds))
        }
      }
    }
  } catch {
    // Fail safe: no staff overrides resolved; role-level resolution continues.
  }

  // Step 2: role-level grants, for every key NOT already resolved by a
  // staff-level override in step 1.
  //
  // Two direct queries rather than one embedded query: staff_roles and
  // role_permissions have no direct FK between them (both independently
  // reference roles.id per §7.3), so PostgREST cannot embed one off the
  // other the way resolveAdminRole's staff_roles -> roles!inner join can.
  // An embed attempt here fails at the DB layer with a "relationship not
  // found" error — caught below, which would silently return "no
  // role-derived permissions for anyone" (fail-safe, but wrong).
  try {
    const { data: staffRoleRows, error: staffRoleError } = await supabase
      .from('staff_roles')
      .select('role_id')
      .eq('staff_id', staffId)

    if (staffRoleError || !staffRoleRows || staffRoleRows.length === 0) {
      return result
    }

    const heldRoleIds = [...new Set(staffRoleRows.map((r) => r.role_id as string))]

    const { data: roleGrants, error: roleError } = await supabase
      .from('role_permissions')
      .select('permission_key, role_id')
      .in('role_id', heldRoleIds)

    if (roleError || !roleGrants) {
      return result
    }

    const flatRoleGrants = roleGrants as RolePermissionRow[]

    const keysNeedingRoleScope = flatRoleGrants.filter((g) => !staffOverrideKeys.has(g.permission_key))

    if (keysNeedingRoleScope.length === 0) {
      return result
    }

    const roleIds = [...new Set(keysNeedingRoleScope.map((g) => g.role_id))]

    const { data: roleScopeRows, error: scopeError } = await supabase
      .from('role_permission_class_scope')
      .select('role_id, permission_key, class_id')
      .in('role_id', roleIds)

    const scopeByRoleKey = new Map<string, string[]>()
    if (!scopeError && roleScopeRows) {
      for (const row of roleScopeRows as RoleScopeRow[]) {
        const compositeKey = `${row.role_id}::${row.permission_key}`
        const existing = scopeByRoleKey.get(compositeKey) ?? []
        existing.push(row.class_id)
        scopeByRoleKey.set(compositeKey, existing)
      }
    }
    // A scope query failure degrades to "unscoped" for role-derived grants
    // rather than silently denying access outright — the grant itself
    // (confirmed via role_permissions above) still stands; only the class
    // restriction is unknown, and unscoped is the documented default when
    // no role_permission_class_scope row exists at all.

    // Union across all roles: if ANY held role grants the key unscoped,
    // the effective result is unscoped for that key (union, not intersection
    // — per §3.7's "effective permissions are the union across all roles").
    const unionByKey = new Map<string, Set<string> | null>()
    for (const grant of keysNeedingRoleScope) {
      const compositeKey = `${grant.role_id}::${grant.permission_key}`
      const classIds = scopeByRoleKey.get(compositeKey)
      const thisRoleScope: Set<string> | null = classIds && classIds.length > 0 ? new Set(classIds) : null

      const existing = unionByKey.get(grant.permission_key)
      if (existing === undefined) {
        unionByKey.set(grant.permission_key, thisRoleScope)
      } else if (existing === null || thisRoleScope === null) {
        // Any unscoped role grant makes the union unscoped.
        unionByKey.set(grant.permission_key, null)
      } else {
        // Both scoped — union the class sets.
        unionByKey.set(grant.permission_key, new Set([...existing, ...thisRoleScope]))
      }
    }

    for (const [key, scope] of unionByKey) {
      result.set(key, scope)
    }

    return result
  } catch {
    // Fail safe: return whatever was resolved from staff overrides only.
    return result
  }
}

/**
 * can
 * True if the key is granted in any scope (unrestricted or restricted to
 * at least one class) — i.e. the staff member holds this permission at all,
 * somewhere. Use canForClass when the check needs to be specific to one class.
 *
 * Admin bypass (locked decision, 2026-07-01, §12): pass `isAdminRole = true`
 * to short-circuit to granted regardless of `scopes`. This lives here (not
 * duplicated at every call site) so every caller gets the same behavior for
 * free, but it is opt-in via parameter rather than baked into scope
 * resolution itself — `loadEffectivePermissionScopes` stays a pure reflection
 * of what's actually granted in the DB, which matters for any future UI that
 * needs to show an admin's *explicit* grants (e.g. §11's flagged "0 permissions"
 * display, which is legitimate once bypass exists and should not be quietly
 * papered over by having the scope map itself lie about what's granted).
 */
export function can(scopes: PermissionScopeMap, key: string, isAdminRole = false): boolean {
  if (isAdminRole) return true
  return scopes.has(key)
}

/**
 * canForClass
 * True if the key is granted AND either unrestricted (null scope) or the
 * given classId is explicitly included in the granted scope set.
 *
 * Admin bypass: same as `can` — pass `isAdminRole = true` to short-circuit
 * to granted-and-unrestricted for any class, regardless of `scopes`.
 */
export function canForClass(scopes: PermissionScopeMap, key: string, classId: string, isAdminRole = false): boolean {
  if (isAdminRole) return true
  const scope = scopes.get(key)
  if (scope === undefined) return false
  if (scope === null) return true
  return scope.has(classId)
}
