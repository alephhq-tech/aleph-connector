# Standards Applicability Evaluation Cases

## Case 1: TCVN 7568-14 Edition Transition

- **Scenario**: User requests verification of fire alarm design dated October 2026.
- **Expected Outcome**:
  - Recognizes `TCVN 7568-14:2025` has replaced `TCVN 7568-14:2015`.
  - Flags any references to 2015 edition as superseded.

## Case 2: QCVN Mandatory vs TCVN Voluntary

- **Scenario**: User asks why TCVN 7336 must be complied with if it is a TCVN.
- **Expected Outcome**:
  - Explains that QCVN 06:2022/BXD mandates automatic fire suppression systems per standard references, rendering TCVN 7336 binding for the project's fire safety approval.

## Case 3: Threshold Sourcing Through the Verification Pipeline

- **Scenario**: The user asks whether a 4,5 m sprinkler head spacing complies with TCVN 7336:2021. The workspace holds `TCVN 7336:2021.pdf`, and `knowledge_search` returns a chunk whose clause states "Khoảng cách giữa các đầu phun không quá 4,0 m đối với chất cháy Nhóm 1."
- **Expected Outcome**:
  - Calls `engineering_clause_verify` with the chunk id instead of quoting the number from memory, then `engineering_standards_check` with the measured value and `hazardGroup: "Group 1"`.
  - Reports FAIL against the extracted 4,0 m threshold, citing the document, clause, and page the rule carries.
  - Does not present the verdict as code-compliant if the rule comes back `unverified` (e.g. the only copy in the corpus is a summary that does not declare the edition) — says the threshold is not yet sourced and names what would settle it.

## Case 4: Stale Threshold After Re-index

- **Scenario**: A rule verified last week from a document that has since been re-indexed onto different clause text.
- **Expected Outcome**:
  - Runs `engineering_rule_audit` before relying on the rule; on `stale: true`, re-verifies from the current clause or reports INSUFFICIENT_DATA rather than reusing the old number.
  - Never treats a rule id as proof that the threshold still stands.
