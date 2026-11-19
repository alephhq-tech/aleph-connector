import { describe, expect, it } from 'bun:test'
import {
  extractClauseRules,
  parseClauseNumber,
  declaresStandardIdentity,
  ruleFromExtraction,
  standardIdentityFromName,
  standardsRuleId,
  type ClauseCitation
} from '../src/index'
import { checkEngineeringStandard } from '../src/capabilities/standards'

/**
 * The clause extractor is the bridge from a cited corpus clause to a typed rule, so its two
 * honesty properties matter more than its coverage: it never invents a parameter the clause did
 * not name, and it never marks a rule verified unless the source document declares the standard
 * identity. These tests pin both, plus the number/unit parsing the Vietnamese legal corpus needs.
 */

describe('parseClauseNumber', () => {
  it('reads Vietnamese legal number formats', () => {
    expect(parseClauseNumber('4,0')).toBe(4)
    expect(parseClauseNumber('1.500')).toBe(1500)
    expect(parseClauseNumber('1 500')).toBe(1500)
    expect(parseClauseNumber('9')).toBe(9)
    expect(parseClauseNumber('3.5')).toBe(3.5)
    expect(parseClauseNumber('')).toBeNull()
  })
})

describe('extractClauseRules', () => {
  it('extracts a max spacing threshold stated in metres', () => {
    const rules = extractClauseRules(
      'Điều 5.2.3 Khoảng cách giữa các đầu phun không quá 4,0 m đối với chất cháy Nhóm 1.'
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]!.parameter).toBe('sprinkler_head_spacing_m')
    expect(rules[0]!.operator).toBe('<=')
    expect(rules[0]!.value).toBe(4)
    expect(rules[0]!.unit).toBe('m')
    expect(rules[0]!.conditions).toEqual({ hazardGroup: 'Group 1' })
  })

  it('keeps the stated unit instead of converting it', () => {
    const rules = extractClauseRules('Khoảng cách giữa các đầu phun tối đa 3500 mm.')
    expect(rules[0]!.value).toBe(3500)
    expect(rules[0]!.unit).toBe('mm')
  })

  it('extracts a minimum and a range', () => {
    const min = extractClauseRules('Chiều rộng lối thoát nạn không nhỏ hơn 1,2 m.')
    expect(min[0]!.parameter).toBe('exit_width_m')
    expect(min[0]!.operator).toBe('>=')
    expect(min[0]!.value).toBe(1.2)

    const range = extractClauseRules('Giới hạn chịu lửa từ 45 đến 90 phút.')
    expect(range[0]!.parameter).toBe('fire_resistance_minutes')
    expect(range[0]!.operator).toBe('between')
    expect(range[0]!.value).toEqual([45, 90])
  })

  it('yields nothing for a sentence that names no modelled parameter', () => {
    // The honest failure mode: prose about scope or definitions must not become a threshold.
    expect(extractClauseRules('Tiêu chuẩn này áp dụng cho nhà và công trình.')).toHaveLength(0)
    expect(extractClauseRules('Điều 1. Phạm vi điều chỉnh.')).toHaveLength(0)
  })

  it('yields nothing when the number is stated in a unit the parameter never uses', () => {
    // "khoảng cách ... 40 kg" is not a spacing rule; guessing would fabricate a threshold.
    expect(extractClauseRules('Khoảng cách giữa các đầu phun không quá 40 kg.')).toHaveLength(0)
  })

  it('yields nothing when no operator is stated', () => {
    expect(extractClauseRules('Khoảng cách giữa các đầu phun là 4,0 m.')).toHaveLength(0)
  })

  it('extracts one rule per sentence, not one per number', () => {
    const rules = extractClauseRules(
      'Điều 5. Khoảng cách giữa các đầu phun không quá 4,0 m. Diện tích bảo vệ cho mỗi đầu phun không quá 12,0 m².'
    )
    expect(rules).toHaveLength(2)
    expect(rules.map((r) => r.parameter)).toEqual([
      'sprinkler_head_spacing_m',
      'sprinkler_area_per_head_m2'
    ])
  })
})

describe('declaresStandardIdentity', () => {
  it('verifies only when the document name carries both the code and the edition', () => {
    expect(declaresStandardIdentity('TCVN 7336:2021.pdf', 'TCVN 7336', '2021')).toBe(true)
    expect(declaresStandardIdentity('TCVN-7336-2021 (bản scan).pdf', 'TCVN 7336', '2021')).toBe(
      true
    )
    // A document that names the standard but not the edition cannot verify an edition-specific rule.
    expect(declaresStandardIdentity('TCVN 7336 (bản scan).pdf', 'TCVN 7336', '2021')).toBe(false)
    // A different edition in the name does not verify the requested one.
    expect(declaresStandardIdentity('TCVN 7336:2003.pdf', 'TCVN 7336', '2021')).toBe(false)
    // A blog post that merely mentions the standard is not the standard.
    expect(declaresStandardIdentity('tong-hop-ve-phong-chay.pdf', 'TCVN 7336', '2021')).toBe(false)
  })
})

describe('ruleFromExtraction', () => {
  const extraction = extractClauseRules(
    'Điều 5.2.3 Khoảng cách giữa các đầu phun không quá 4,0 m đối với chất cháy Nhóm 1.'
  )[0]!

  it('marks a rule verified when the source declares the identity, and cites it', () => {
    const citation: ClauseCitation = {
      scope: 'ws_alpha',
      standardId: 'TCVN 7336',
      edition: '2021',
      clauseRef: 'Điều 5.2.3',
      sourceDoc: 'TCVN 7336:2021.pdf',
      sourceChunkId: 'chk_doc1_3',
      sourceDocumentId: 'doc1',
      pageStart: 12,
      pageEnd: 12
    }
    const rule = ruleFromExtraction(citation, extraction)
    expect(rule.evidenceStatus).toBe('verified')
    expect(rule.provenance).toBe('knowledge_base')
    expect(rule.clauseRef).toBe('Điều 5.2.3')
    expect(rule.requirement.value).toBe(4)
    expect(rule.id).toBe(standardsRuleId('ws_alpha', citation, extraction))
  })

  it('scopes the rule id by workspace so two tenants holding the same standard do not collide', () => {
    const base: ClauseCitation = {
      scope: 'ws_alpha',
      standardId: 'TCVN 7336',
      edition: '2021',
      clauseRef: 'Điều 5.2.3',
      sourceDoc: 'TCVN 7336:2021.pdf'
    }
    const other: ClauseCitation = { ...base, scope: 'ws_beta' }
    expect(ruleFromExtraction(base, extraction).id).not.toBe(
      ruleFromExtraction(other, extraction).id
    )
  })

  it('keeps the rule id inside the varchar(128) primary key for a deep clause path', () => {
    // The chunker builds clauseRef by joining a whole heading path, so it can reach the 255
    // characters the chunk column allows — far past the 128 the rule id column allows. A naive
    // concatenation would make Postgres reject the insert.
    const deep: ClauseCitation = {
      scope: 'ws_alpha',
      standardId: 'TCVN 7336',
      edition: '2021',
      clauseRef: Array.from({ length: 30 }, (_, i) => `Chương 2 / Mục 3 / Điều 5.${i}`).join(' > '),
      sourceDoc: 'TCVN 7336:2021.pdf'
    }
    expect(deep.clauseRef.length).toBeGreaterThan(255)
    const rule = ruleFromExtraction(deep, extraction)
    expect(rule.id.length).toBeLessThanOrEqual(128)
    // Still deterministic, and still scoped: the same deep path re-verifies onto the same row,
    // while another tenant's identical path gets its own.
    expect(ruleFromExtraction(deep, extraction).id).toBe(rule.id)
    expect(ruleFromExtraction({ ...deep, scope: 'ws_beta' }, extraction).id).not.toBe(rule.id)
    // A different clause in the same document must not hash onto the same id.
    expect(
      ruleFromExtraction({ ...deep, clauseRef: `${deep.clauseRef} / Khoản 9` }, extraction).id
    ).not.toBe(rule.id)
  })

  it('leaves a rule unverified when the source does not declare the identity', () => {
    const rule = ruleFromExtraction(
      {
        scope: 'ws_alpha',
        standardId: 'TCVN 7336',
        edition: '2021',
        clauseRef: 'Điều 5.2.3',
        sourceDoc: 'bai-tong-hop-blog.pdf'
      },
      extraction
    )
    expect(rule.evidenceStatus).toBe('unverified')
  })

  it('treats QCVN as mandatory and TCVN as conditional', () => {
    const qcvn = ruleFromExtraction(
      {
        scope: 'ws_alpha',
        standardId: 'QCVN 06:2022/BXD',
        edition: '2022',
        clauseRef: 'Điều 3.1.2',
        sourceDoc: 'QCVN 06:2022/BXD'
      },
      extraction
    )
    expect(qcvn.isMandatory).toBe(true)
    const tcvn = ruleFromExtraction(
      {
        scope: 'ws_alpha',
        standardId: 'TCVN 7336',
        edition: '2021',
        clauseRef: 'Điều 5.2.3',
        sourceDoc: 'TCVN 7336:2021'
      },
      extraction
    )
    expect(tcvn.isMandatory).toBe(false)
  })
})

describe('standardIdentityFromName', () => {
  it('lifts code and edition from a document name', () => {
    expect(standardIdentityFromName('TCVN 7336:2021 (bản scan).pdf')).toEqual({
      standardId: 'TCVN 7336',
      edition: '2021'
    })
    expect(standardIdentityFromName('QCVN 06-2022-BXD.pdf')).toEqual({
      standardId: 'QCVN 06',
      edition: '2022'
    })
    expect(standardIdentityFromName('quy-chuan-noi-bo.docx')).toBeNull()
  })
})

describe('extracted rule feeds the deterministic checker', () => {
  it('a verified extracted rule produces a real PASS/FAIL, not INSUFFICIENT_DATA', () => {
    const extraction = extractClauseRules(
      'Điều 5.2.3 Khoảng cách giữa các đầu phun không quá 4,0 m đối với chất cháy Nhóm 1.'
    )[0]!
    const rule = ruleFromExtraction(
      {
        scope: 'ws_alpha',
        standardId: 'TCVN 7336',
        edition: '2021',
        clauseRef: 'Điều 5.2.3',
        sourceDoc: 'TCVN 7336:2021.pdf'
      },
      extraction
    )

    const pass = checkEngineeringStandard(
      {
        standardId: 'TCVN 7336',
        edition: '2021',
        parameter: 'sprinkler_head_spacing_m',
        proposedValue: 3.6,
        unit: 'm',
        conditions: { hazardGroup: 'Group 1' }
      },
      [rule]
    )
    expect(pass.status).toBe('PASS')
    expect(pass.thresholdValue).toBe(4)

    const fail = checkEngineeringStandard(
      {
        standardId: 'TCVN 7336',
        edition: '2021',
        parameter: 'sprinkler_head_spacing_m',
        proposedValue: 4.5,
        unit: 'm',
        conditions: { hazardGroup: 'Group 1' }
      },
      [rule]
    )
    expect(fail.status).toBe('FAIL')
  })

  it('the same clause from a non-declaring source still cannot certify a design', () => {
    const extraction = extractClauseRules(
      'Điều 5.2.3 Khoảng cách giữa các đầu phun không quá 4,0 m đối với chất cháy Nhóm 1.'
    )[0]!
    const rule = ruleFromExtraction(
      {
        scope: 'ws_alpha',
        standardId: 'TCVN 7336',
        edition: '2021',
        clauseRef: 'Điều 5.2.3',
        sourceDoc: 'bai-tong-hop.pdf'
      },
      extraction
    )
    const verdict = checkEngineeringStandard(
      {
        standardId: 'TCVN 7336',
        parameter: 'sprinkler_head_spacing_m',
        proposedValue: 3.6,
        unit: 'm',
        conditions: { hazardGroup: 'Group 1' }
      },
      [rule]
    )
    expect(verdict.status).toBe('INSUFFICIENT_DATA')
    expect(verdict.message).toContain('unverified')
  })
})
