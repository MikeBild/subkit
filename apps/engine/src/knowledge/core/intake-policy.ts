import { createHash } from "node:crypto";

export interface IntakeParty {
  kind: string;
  id: string | null;
}

export type IntakeConfirmVerdict = "allowed" | "own_proposal";

export function decideIntakeConfirmer(input: {
  policy: "single" | "pair";
  proposer: IntakeParty;
  confirmer: IntakeParty;
}): IntakeConfirmVerdict {
  if (input.policy !== "pair") return "allowed";
  if (input.proposer.id === null || input.confirmer.id === null) return "allowed";
  return input.proposer.kind === input.confirmer.kind && input.proposer.id === input.confirmer.id
    ? "own_proposal"
    : "allowed";
}

export function assistantIntakeRequestId(parts: readonly string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
