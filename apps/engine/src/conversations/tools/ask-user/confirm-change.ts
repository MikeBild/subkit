const CHANGE_KEYS = ["reason", "feedback", "comment", "changes", "change", "message", "note"];

const PLAIN_AGREEMENT = new Set([
  "ok",
  "okay",
  "ja",
  "yes",
  "y",
  "j",
  "passt",
  "gut",
  "danke",
  "thanks",
  "thank you",
  "go",
  "einverstanden",
  "genehmigt",
  "approved",
  "lgtm",
  "looks good",
  "sieht gut aus",
  "mach das",
  "do it",
]);

export const APPROVAL_WITH_CHANGE_MESSAGE =
  "An approval with a comment is not an approval: nothing ran and the request is still open. Approve without a comment to run exactly what is shown, or decline with the comment so the action can be changed first.";

function bindsAction(input: Record<string, unknown>): boolean {
  return (
    (typeof input.commit_intent === "object" && input.commit_intent !== null) ||
    (typeof input.target === "object" && input.target !== null)
  );
}

function plainAgreement(text: string): boolean {
  const folded = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return folded.length === 0 || PLAIN_AGREEMENT.has(folded);
}

export function approvalChange(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  reason?: string | null,
): string | null {
  if (!bindsAction(input)) return null;
  const texts = [reason, ...CHANGE_KEYS.map((key) => output[key])];
  for (const text of texts) {
    if (typeof text === "string" && !plainAgreement(text)) return text;
  }
  return null;
}
