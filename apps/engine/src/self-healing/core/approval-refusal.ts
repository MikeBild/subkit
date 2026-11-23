export interface ApprovalFacts {
  selection_requested: boolean;
  partial: boolean;
  review_reason: string | null;
  review_digest: string | null;
  expected_review_digest: string | null;
  tested_digest: string | null;
}

export function approvalRefusal(facts: Readonly<ApprovalFacts>): string | null {
  if (facts.selection_requested && facts.review_digest === null)
    return facts.review_reason ?? "accepted_operations_invalid";
  if (facts.expected_review_digest && facts.review_digest !== facts.expected_review_digest)
    return facts.review_reason ?? "review_changed";
  if (
    facts.partial &&
    (!facts.expected_review_digest || facts.tested_digest !== facts.review_digest)
  )
    return "dry_run_required";
  return null;
}
