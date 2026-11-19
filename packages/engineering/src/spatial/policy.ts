/**
 * Engineering zone policy — the project-configurable half of spatial safety.
 *
 * A policy says which engineering system may do what inside which zone class, and every rule
 * carries the authority it came from. Two rules this module exists to enforce:
 *
 * 1. **A model cannot invent an exception.** `exemptions: ['whatever']` on a placement is not
 *    authority; a `conditional` rule only clears when an authorization object names the same rule
 *    and the same run/workspace, and that object is server-issued (a user approval or an approved
 *    Design Basis), never a field in the mutation payload.
 * 2. **Silence is not permission.** If no rule covers `(system, zoneClass)`, the answer is
 *    `no_rule`, and the caller decides whether that means "allow" (open system) or "block"
 *    (safety-critical system). It is never resolved by guessing here.
 *
 * Policies are generic on purpose: `system` is `fire_alarm`, `sprinkler`, `electrical`, `hvac`,
 * `plumbing` or any project vocabulary — the mechanism does not change per discipline.
 */

export type PolicyEffect = 'prohibit' | 'conditional'

/** Where a rule's authority came from. Everything here is server-side data, never payload. */
export interface PolicyAuthority {
  source: 'project_config' | 'design_basis' | 'user_approval'
  ref: string
}

export interface PolicyRule {
  id: string
  /** Zone class the rule protects, e.g. `elevator_shaft`, `stairwell`, `electrical_riser`. */
  zoneClass: string
  /** Engineering system the rule applies to. `'*'` matches every system. */
  system: string
  effect: PolicyEffect
  /**
   * For `conditional`: what may be authorized inside the zone. Both lists are optional; when
   * present, a request must be inside every supplied list to match.
   */
  permits?: {
    deviceTypes?: string[]
    operations?: string[]
  }
  authority: PolicyAuthority
  note?: string
}

export interface EngineeringPolicy {
  id: string
  version: string
  projectRef: string
  designBasisId?: string
  /** ISO timestamp the policy was approved; a policy without one is not auditable. */
  approvedAt?: number
  rules: PolicyRule[]
}

/** What the caller is about to do, structurally. */
export interface PolicyMatch {
  system: string
  zoneClass: string
  deviceType?: string
  operation?: 'place' | 'route_through' | 'pass'
}

/** A server-issued permission to proceed under a `conditional` rule. */
export interface PolicyAuthorization {
  id: string
  ruleId: string
  grantedBy: 'user' | 'design_basis'
  provenance: string
  runId: string
  workspaceId: string
}

export type PolicyDecision = 'allow' | 'block' | 'needs_authorization' | 'no_rule'

export interface PolicyVerdict {
  decision: PolicyDecision
  ruleId?: string
  policyId?: string
  policyVersion?: string
  reason: string
}

const ruleMatches = (rule: PolicyRule, match: PolicyMatch): boolean =>
  (rule.system === '*' || rule.system === match.system) && rule.zoneClass === match.zoneClass

const permitted = (rule: PolicyRule, match: PolicyMatch): boolean => {
  const p = rule.permits
  if (!p) return true
  if (p.deviceTypes && (!match.deviceType || !p.deviceTypes.includes(match.deviceType)))
    return false
  if (p.operations && (!match.operation || !p.operations.includes(match.operation))) return false
  return true
}

/**
 * Evaluate the applicable rules for one action, most-specific permission first.
 *
 * A `conditional` rule whose permits cover this exact device/operation is narrower than a blanket
 * `prohibit`, so it governs: that is what lets a project say "no fire alarm devices in the
 * stairwell" while still permitting an emergency light there behind an explicit authorization.
 * The model can neither add that rule (it is server-side project configuration) nor invent the
 * authorization, so honoring the narrower rule is not a bypass — meanwhile any action the narrow
 * rule does NOT permit still falls through to the prohibition and blocks.
 */
export function evaluatePolicy(
  policies: readonly EngineeringPolicy[],
  match: PolicyMatch,
  authorizations: readonly PolicyAuthorization[] = [],
  binding: { runId: string; workspaceId: string } = { runId: '', workspaceId: '' }
): PolicyVerdict {
  const applicable = policies.flatMap((p) =>
    p.rules.filter((r) => ruleMatches(r, match)).map((r) => ({ policy: p, rule: r }))
  )
  if (applicable.length === 0) {
    return {
      decision: 'no_rule',
      reason: `no policy rule covers ${match.system} in a ${match.zoneClass} zone`
    }
  }

  const permittedRules = applicable.filter(
    (a) => a.rule.effect === 'conditional' && permitted(a.rule, match)
  )
  if (permittedRules.length > 0) {
    const { policy, rule } = permittedRules[0]!
    // Conditional: needs a server-issued authorization bound to THIS run and workspace. A string
    // in the mutation payload is never an authorization; that is exactly how a model would excuse
    // its own violation.
    const satisfied = authorizations.some(
      (auth) =>
        auth.ruleId === rule.id &&
        auth.runId === binding.runId &&
        auth.workspaceId === binding.workspaceId
    )
    if (!satisfied) {
      return {
        decision: 'needs_authorization',
        ruleId: rule.id,
        policyId: policy.id,
        policyVersion: policy.version,
        reason: `${policy.id}@${policy.version} rule ${rule.id} permits ${match.deviceType ?? match.operation} in ${match.zoneClass} only with an explicit authorization (granted via user approval or the approved Design Basis)`
      }
    }
    return {
      decision: 'allow',
      ruleId: rule.id,
      policyId: policy.id,
      policyVersion: policy.version,
      reason: `${policy.id}@${policy.version} rule ${rule.id} authorized for this run`
    }
  }

  const blocks = applicable.filter((a) => a.rule.effect === 'prohibit')
  if (blocks.length > 0) {
    const { policy, rule } = blocks[0]!
    return {
      decision: 'block',
      ruleId: rule.id,
      policyId: policy.id,
      policyVersion: policy.version,
      reason: `${policy.id}@${policy.version} rule ${rule.id} prohibits ${match.operation ?? 'action'}${match.deviceType ? ` of ${match.deviceType}` : ''} in ${match.zoneClass} (authority: ${rule.authority.source}:${rule.authority.ref})`
    }
  }

  // Only conditionals apply and none permits this device/operation: silence about a device class
  // is not permission to put it in a protected zone.
  const { policy, rule } = applicable[0]!
  return {
    decision: 'block',
    ruleId: rule.id,
    policyId: policy.id,
    policyVersion: policy.version,
    reason: `${policy.id}@${policy.version} rule ${rule.id} is the only rule for ${match.zoneClass} and does not permit ${match.deviceType ?? 'this device'} for ${match.operation ?? 'this operation'}`
  }
}

/** Digest of the policy set a verdict was reached under, so a record can bind to it. */
export function policySetVersion(policies: readonly EngineeringPolicy[]): string {
  return policies
    .map((p) => `${p.id}@${p.version}:${p.rules.length}`)
    .sort()
    .join('|')
}
