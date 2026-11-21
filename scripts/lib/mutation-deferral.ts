export const DEFER_MUTATION_FLAG = "--defer-mutation";

export type MutationEvidence = "verified" | "deferred";

export interface MutationDeferral {
  readonly mutation: MutationEvidence;
  readonly rest: readonly string[];
}

export function parseMutationDeferral(argv: readonly string[]): MutationDeferral {
  const rest = argv.filter((arg) => arg !== DEFER_MUTATION_FLAG);
  return { mutation: rest.length === argv.length ? "verified" : "deferred", rest };
}

export function mutationDeferralWarning(subject: string): string {
  const rule = "!".repeat(78);
  return [
    rule,
    `!! MUTATION EVIDENCE DEFERRED for ${subject}`,
    "!! bun run quality release --check was skipped on purpose (--defer-mutation).",
    "!! This release ships without mutation evidence; the release states mutation: deferred.",
    rule,
  ].join("\n");
}

const GATE_DESCRIPTION = "Mandatory local verification and live models passed";

export function releaseGateDescription(mutation: MutationEvidence): string {
  return mutation === "deferred" ? `${GATE_DESCRIPTION}; mutation: deferred` : GATE_DESCRIPTION;
}

export function mutationFromGateDescription(description: unknown): MutationEvidence {
  return typeof description === "string" && description.endsWith("; mutation: deferred")
    ? "deferred"
    : "verified";
}

export function releaseNotesMutationLine(mutation: MutationEvidence): string {
  return mutation === "deferred"
    ? "Mutation evidence: deferred. This release was tagged without `quality release` evidence; it follows separately.\n"
    : "";
}
