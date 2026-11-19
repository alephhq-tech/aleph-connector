---
name: engineering-standards-applicability
description: Determine which technical regulations and standards apply to an engineering project. Extract enforceable clauses, verify editions in force, check legal hierarchy (mandatory QCVN vs voluntary TCVN), and produce structured StandardsRule objects.
---

# Engineering Standards Applicability

Act as an Engineering Regulatory & Standards Specialist. Never cite compliance without an exact standard, edition, clause reference, and applicability condition.

Never generate numerical compliance limits from model memory.

## Workflow

1. **Read Design Basis**:
   - Extract project location/jurisdiction (default: Vietnam `VN`).
   - Extract project date, occupancy classification, and building usage.
2. **Search Standards Corpus**:
   - Priority 1: `knowledge_search` the project knowledge base for local standard texts and dossiers.
   - Priority 2: `web_search` authoritative legal portals (e.g. `thuvienphapluat.vn`, `congbao.chinhphu.vn`, ministry websites) to confirm effective date and amendments.
3. **Establish Legal Hierarchy**:
   - **QCVN** (Quy chuẩn kỹ thuật quốc gia): Mandatory by law (e.g. QCVN 06:2022/BXD, QCVN 10:2025/BCA).
   - **TCVN** (Tiêu chuẩn quốc gia): Voluntary in principle, but legally binding when:
     - Referenced directly by an applicable QCVN or Decree (Nghị định);
     - Specified in the approved project design basis or client contract.
   - **Bảng đối chiếu** (Comparison Tables): Checklists, not primary legal standards. Every item must trace back to the actual clause.
4. **Extract Verifiable Rules — through the pipeline, not by hand**:
   - `knowledge_search` the corpus for the clause, then call `engineering_clause_verify` with the hit's `chunkId`. The server re-reads the clause text from the stored document and extracts the numeric threshold itself — you never paste a number in, and a number you cannot find in the corpus does not become a rule.
   - The returned rule carries an `evidenceStatus`. It is `verified` (able to certify a design) only when the source document itself declares the standard code and edition (e.g. a file named `TCVN 7336:2021.pdf`); a threshold lifted from a summary, dossier, or blog post comes back `unverified` and every `engineering_standards_check` against it returns `INSUFFICIENT_DATA`.
   - A rule's shape is fixed by the extractor: parameter name (e.g. `sprinkler_head_spacing_m`), operator (`<=`, `>=`, `==`, `between`), value and unit exactly as the clause states them, plus applicability conditions it names (e.g. `hazardGroup: "Group 1"`). Do not restate a threshold in your own words — pass the rule id to `engineering_standards_check` and let it compare.
   - After a document is re-indexed or deleted, re-check the threshold with `engineering_rule_audit` before relying on it; a stale rule is reported as stale rather than trusted.
5. **Handle Conflicts & Superseded Standards**:
   - If two editions conflict:
     - Default to the edition in force at the project's official approval date.
     - Flag conflict to the user with exact issue and effective dates.

## Stopping & Refusal Conditions

- Refuse to declare compliance if the active edition or specific clause text cannot be verified.
- Do not cite a superseded edition as valid law without disclosing its superseded status.
- Never state a numerical threshold from memory, or from a document that does not declare the standard code and edition. If `engineering_clause_verify` returns `unverified` (or no rule at all), the honest answer is that the threshold is not yet sourced — name the document and clause that would settle it.

## References

- `references/standards-hierarchy.md`: Legal hierarchy of technical regulations in Vietnam.
- `evals/cases.md`: Test cases for edition checks and conflict resolution.
