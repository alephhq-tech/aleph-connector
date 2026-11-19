import { createHash } from 'node:crypto'

import type { RuleOperator, StandardsRule } from '../schemas/standards-rule'

/**
 * Deterministic clause extractor (PR 5: knowledge-to-engineering workflow).
 *
 * Turns a clause of Vietnamese regulatory text — a knowledge chunk that already carries page +
 * clause provenance from the ingestion pipeline — into typed numeric rule candidates, so the
 * standards checker can compare a measured design value against a threshold that came from a real
 * document instead of a value transcribed from memory.
 *
 * It is deliberately regex/keyword based, not model based: the same clause text must always yield
 * the same threshold, and a reviewer must be able to point at the exact words the number came
 * from. It never invents a parameter: if no known parameter keyword appears in a sentence, that
 * sentence yields nothing and the caller reports INSUFFICIENT_DATA.
 *
 * The evidence gate is the honest part. Extracting a number from a corpus document is NOT the same
 * as verifying it against an authoritative source: `evidenceStatus` becomes `verified` only when
 * the source document itself declares the standard identity (its name carries both the standard
 * code and the edition), so a threshold lifted from a blog post or a second-hand summary stays
 * `unverified` and can never certify a design.
 */

/** One numeric requirement found in a clause sentence, with the exact words it came from. */
export interface ExtractedClauseRule {
  /** Canonical parameter name, e.g. `sprinkler_head_spacing_m`. */
  parameter: string
  operator: RuleOperator
  /** A `between` rule carries `[low, high]`; every other operator a single number. */
  value: number | number[]
  /** Unit exactly as written in the clause — never silently converted. A clause that states mm
   * against a `_m` parameter is left mismatched so the checker forces an explicit conversion. */
  unit: string
  /** The sentence fragment the number came from — the evidence a reviewer reads. */
  matchedText: string
  /** Applicability conditions named in the sentence (e.g. hazard group). */
  conditions: Record<string, unknown>
}

/** Citation carried from the knowledge chunk into the rule. */
export interface ClauseCitation {
  /** The workspace that verified the clause — part of the rule id, so two tenants holding the
   * same standard each own their own rule row. */
  scope: string
  /** The retrieval scope of the source chunk: `null`/undefined = a Workspace-Knowledge clause, a
   * project id = that Project's private source. Part of the rule id (so two Projects in the SAME
   * workspace verifying the same clause each own a row instead of overwriting one another) and
   * persisted on the rule so reads can apply the same scope policy as chunk search. */
  projectId?: string | null
  standardId: string
  edition: string
  clauseRef: string
  sourceDoc: string
  sourceChunkId?: string | null
  sourceDocumentId?: string | null
  pageStart?: number | null
  pageEnd?: number | null
}

interface ParameterKeyword {
  parameter: string
  /** Any of these phrases in a sentence names this parameter. */
  patterns: RegExp[]
  /** Units a value for this parameter may be stated in; anything else is not this parameter. */
  units: string[]
}

/**
 * The parameter vocabulary. Kept narrow on purpose: a keyword list wide enough to match anything
 * would manufacture rules the corpus never stated. Each entry names a parameter the deterministic
 * calculation pipeline actually consumes, and the unit family it is expressed in.
 */
const PARAMETER_KEYWORDS: ParameterKeyword[] = [
  {
    parameter: 'sprinkler_head_spacing_m',
    patterns: [
      /khoảng cách giữa các đầu phun/i,
      /khoảng cách (các )?đầu phun/i,
      /spacing between (sprinkler )?heads/i
    ],
    units: ['m', 'mm', 'cm']
  },
  {
    parameter: 'sprinkler_wall_clearance_m',
    patterns: [
      /khoảng cách từ đầu phun đến tường/i,
      /đầu phun.*(cách|sát).*tường/i,
      /wall clearance/i
    ],
    units: ['m', 'mm', 'cm']
  },
  {
    parameter: 'sprinkler_area_per_head_m2',
    patterns: [
      /diện tích (bảo vệ )?(cho|của|tính cho) (mỗi|từng|1|một) đầu phun/i,
      /area per (sprinkler )?head/i
    ],
    units: ['m2', 'm²']
  },
  {
    parameter: 'exit_width_m',
    patterns: [
      /chiều rộng (lối (ra|thoát nạn)|cửa (ra|thoát nạn)|lối đi thoát nạn)/i,
      /lối (ra|thoát nạn)[^.;]{0,40}rộng/i,
      /(exit|egress) width/i
    ],
    units: ['m', 'mm', 'cm']
  },
  {
    parameter: 'travel_distance_m',
    patterns: [/khoảng cách (di chuyển|thoát nạn|từ nơi xa nhất)/i, /travel distance/i],
    units: ['m', 'mm']
  },
  {
    parameter: 'detector_spacing_m',
    patterns: [
      /khoảng cách giữa các (đầu )?báo cháy/i,
      /khoảng cách (lắp đặt )?(đầu )?báo cháy/i,
      /detector spacing/i
    ],
    units: ['m', 'mm']
  },
  {
    parameter: 'detector_wall_clearance_m',
    patterns: [/khoảng cách từ (đầu )?báo cháy đến tường/i],
    units: ['m', 'mm']
  },
  {
    parameter: 'water_pressure_bar',
    patterns: [/áp suất (nước|nguồn|cung cấp|tối thiểu tại|tại họng)/i, /source pressure/i],
    units: ['bar', 'kpa', 'mpa', 'atm']
  },
  {
    parameter: 'water_flow_lpm',
    patterns: [/lưu lượng (nước|tính toán|yêu cầu|chữa cháy)/i, /flow rate/i],
    units: ['l/min', 'l/phút', 'l/s', 'm3/s', 'm³/s']
  },
  {
    parameter: 'fire_resistance_minutes',
    patterns: [/giới hạn chịu lửa/i, /thời gian chịu lửa/i, /fire resistance rating/i],
    units: ['phút', 'min', 'minute', 'minutes']
  },
  {
    parameter: 'egress_capacity_p',
    patterns: [/số người (tối đa|cho phép) (trên|cho)/i, /mật độ (người|chiếm chỗ)/i],
    units: ['người', 'p', 'persons', 'm2/người', 'm²/người']
  }
]

/** Operator phrases, longest/most specific first so "không nhỏ hơn" never reads as "không quá". */
const OPERATOR_PATTERNS: { operator: RuleOperator; pattern: RegExp }[] = [
  { operator: '<=', pattern: /(không quá|không lớn hơn|tối đa|không vượt quá|≤|<=)/i },
  { operator: '>=', pattern: /(không nhỏ hơn|không dưới|tối thiểu|ít nhất|≥|>=)/i },
  { operator: 'between', pattern: /(từ|trong khoảng)\s+[\d.,]+\s*(đến|tới|-|–|÷)\s*[\d.,]+/i },
  { operator: '<', pattern: /(<(?!<))/ },
  { operator: '>', pattern: /(>(?!>))/ },
  { operator: '==', pattern: /(bằng đúng|bằng)/i }
]

/** A number as Vietnamese legal text writes it: `4,0`, `1.500`, `1 500`, `9`. */
const NUMBER = String.raw`\d{1,3}(?:[ .]\d{3})*(?:[,\u002E]\d+)?|\d+(?:[,\u002E]\d+)?`

const UNIT = String.raw`(?:m²|m2|m³|m3|mm|cm|m|kpa|mpa|bar|atm|l\/min|l\/phút|l\/s|phút|min|minutes?|người|m2\/người|m²\/người|%)`

/** `NUM unit` with an optional thin space between number and unit. */
const NUMBER_UNIT = new RegExp(`(${NUMBER})\\s*(${UNIT})`, 'gi')

/** Hazard-group applicability, the one condition the deterministic pipeline can read reliably. */
const HAZARD_GROUP = /(?:nhóm|group)\s*([123])/i

/**
 * Parses a Vietnamese/English legal number: `.` and ` ` group thousands, `,` is the decimal
 * separator (`4,0 m` = 4.0; `1.500 mm` = 1500). A lone `.` with exactly 3 trailing digits is also
 * a thousands separator, which is how the corpus writes `1.500`.
 */
export function parseClauseNumber(raw: string): number | null {
  const cleaned = raw.trim()
  if (!cleaned) return null
  const asThousandsAndDecimal = cleaned.replace(/[ .](?=\d{3}(?:\D|$))/g, '').replace(',', '.')
  const n = Number(asThousandsAndDecimal)
  return Number.isFinite(n) ? n : null
}

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, '')
}

/** Splits clause text into sentence-sized fragments; a fragment is the unit of one rule. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.;:])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Finds the parameter a sentence names, or null when it names none we model. */
function matchParameter(sentence: string): ParameterKeyword | null {
  for (const entry of PARAMETER_KEYWORDS) {
    if (entry.patterns.some((p) => p.test(sentence))) return entry
  }
  return null
}

function readConditions(sentence: string): Record<string, unknown> {
  const conditions: Record<string, unknown> = {}
  const hazard = HAZARD_GROUP.exec(sentence)
  if (hazard) conditions.hazardGroup = `Group ${hazard[1]}`
  return conditions
}

/**
 * Extracts every numeric requirement the clause text states for a known parameter.
 *
 * A sentence yields at most one rule: the first parameter keyword it names, paired with the first
 * operator + number + unit that fits that parameter's unit family. Sentences that name no known
 * parameter, or whose number is stated in a unit the parameter is never expressed in, yield
 * nothing — the caller reports INSUFFICIENT_DATA rather than guessing.
 */
export function extractClauseRules(text: string): ExtractedClauseRule[] {
  const out: ExtractedClauseRule[] = []

  for (const sentence of sentences(text)) {
    const parameter = matchParameter(sentence)
    if (!parameter) continue

    const operatorEntry = OPERATOR_PATTERNS.find((o) => o.pattern.test(sentence))
    if (!operatorEntry) continue

    if (operatorEntry.operator === 'between') {
      const between = new RegExp(
        `(?:từ|trong khoảng)\\s*(${NUMBER})\\s*(?:đến|tới|-|–|÷)\\s*(${NUMBER})\\s*(${UNIT})?`,
        'i'
      )
      const m = between.exec(sentence)
      if (!m) continue
      const low = parseClauseNumber(m[1]!)
      const high = parseClauseNumber(m[2]!)
      const unit = m[3] ? normalizeUnit(m[3]) : ''
      if (low == null || high == null) continue
      if (unit && !parameter.units.includes(unit)) continue
      out.push({
        parameter: parameter.parameter,
        operator: 'between',
        value: [low, high],
        unit: unit || parameter.units[0]!,
        matchedText: sentence,
        conditions: readConditions(sentence)
      })
      continue
    }

    // Walk every number+unit pair and take the first whose unit fits the parameter.
    NUMBER_UNIT.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = NUMBER_UNIT.exec(sentence))) {
      const value = parseClauseNumber(m[1]!)
      const unit = normalizeUnit(m[2]!)
      if (value == null) continue
      if (!parameter.units.includes(unit)) continue
      out.push({
        parameter: parameter.parameter,
        operator: operatorEntry.operator,
        value,
        unit,
        matchedText: sentence,
        conditions: readConditions(sentence)
      })
      break
    }
  }

  return out
}

/**
 * True when `sourceDoc` declares the standard identity: its name carries both the standard code
 * and the edition year. This is what lets an extracted rule be `verified` — the number came from
 * the standard's own text, not from a document that merely mentions it.
 *
 * Codes are matched loosely (`TCVN 7336:2021`, `TCVN-7336-2021`, `tcvn 7336 2021` all agree) but
 * the edition must appear as a 4-digit year, so a document named just "TCVN 7336" does not verify
 * a rule for the 2021 edition.
 */
export function declaresStandardIdentity(
  sourceDoc: string,
  standardId: string,
  edition: string
): boolean {
  const doc = sourceDoc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const code = standardId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!code || !doc.includes(code)) return false
  const years = doc.match(/\b(19|20)\d{2}\b/g) ?? []
  const wanted = edition.trim()
  return years.some((y) => y === wanted || y.startsWith(wanted))
}

/**
 * Stable id so re-verifying the same clause replaces its rule in place instead of accumulating.
 *
 * `scope` (the workspace that verified the clause) is part of the id on purpose: the id is the
 * table's primary key, and two workspaces that each hold their own copy of TCVN 7336 legitimately
 * own separate rules. A clause-derived id without a scope collides across tenants, and an upsert
 * keyed on it silently rewrites another workspace's row — the row keeps its original
 * `workspace_id`, so the second workspace's verification appears to succeed and then reads back
 * as nothing.
 *
 * The retrieval scope (`citation.projectId`) is folded into the same scope component: two Projects
 * in ONE workspace that each verify the same clause must own separate rows, exactly as two
 * workspaces do — otherwise Project B's verification silently rewrites Project A's rule (and the
 * row keeps A's `project_id`, so B's check then reads back as nothing). A workspace-level
 * verification (projectId null) keeps the bare workspace scope, so existing workspace-scoped rule
 * ids are unchanged.
 *
 * The id lands in a `varchar(128)` primary key, while the pieces it is built from are not bounded
 * by that (a chunk's `clauseRef` may run to 255 characters — the chunker joins a whole heading
 * path). So the readable form is used when it fits, and a deep heading path falls back to a hash of
 * the same fields: still deterministic, still unique per (scope, project, standard, edition,
 * clause, parameter), and still scoped per tenant.
 */
const MAX_RULE_ID_LENGTH = 128

export function standardsRuleId(
  scope: string,
  citation: ClauseCitation,
  extraction: ExtractedClauseRule
): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  // A workspace-level rule keeps the historical bare-workspace scope key; a project-scoped rule
  // gets a project discriminator so two Projects in one workspace never collide.
  const scopeKey = citation.projectId ? `${scope}#${citation.projectId}` : scope
  const readable = `sr_${slug(scopeKey)}_${slug(citation.standardId)}_${slug(
    citation.edition
  )}_${slug(citation.clauseRef)}_${slug(extraction.parameter)}`
  if (readable.length <= MAX_RULE_ID_LENGTH) return readable
  const identity = [
    scopeKey,
    citation.standardId,
    citation.edition,
    citation.clauseRef,
    extraction.parameter
  ].join('\u0000')
  return `sr_${slug(scopeKey).slice(0, 40)}_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

/**
 * Builds a persisted-ready rule from an extraction + its citation.
 *
 * `evidenceStatus` is decided here, not by the caller: `verified` only when the source document
 * declares the standard identity, otherwise `unverified`. `isMandatory` follows the Vietnamese
 * hierarchy — QCVN are regulations (mandatory), TCVN are standards (applied when invoked).
 */
export function ruleFromExtraction(
  citation: ClauseCitation,
  extraction: ExtractedClauseRule
): StandardsRule {
  const verified = declaresStandardIdentity(
    citation.sourceDoc,
    citation.standardId,
    citation.edition
  )
  return {
    id: standardsRuleId(citation.scope, citation, extraction),
    standardId: citation.standardId,
    edition: citation.edition,
    sourceDoc: citation.sourceDoc,
    clauseRef: citation.clauseRef,
    jurisdiction: 'VN',
    isMandatory: /^\s*qcvn/i.test(citation.standardId),
    conditions: extraction.conditions,
    requirement: {
      parameter: extraction.parameter,
      operator: extraction.operator,
      value: extraction.value,
      unit: extraction.unit
    },
    provenance: 'knowledge_base',
    verificationMethod: 'document_review',
    evidenceStatus: verified ? 'verified' : 'unverified'
  }
}

/** Standard code + edition lifted from a document name, e.g. "TCVN 7336:2021 (bản scan).pdf". */
export function standardIdentityFromName(name: string): {
  standardId: string
  edition: string
} | null {
  const m = /(TCVN|QCVN|TCXDVN)\s*[-\s]?\s*(\d{1,5})\s*[:]?\s*[-\s]?\s*((?:19|20)\d{2})?/i.exec(
    name
  )
  if (!m) return null
  return {
    standardId: `${m[1]!.toUpperCase()} ${m[2]}`,
    edition: m[3] ?? ''
  }
}
