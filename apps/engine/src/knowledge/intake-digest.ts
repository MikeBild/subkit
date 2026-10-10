import { createHash } from "node:crypto";
import type { IntakeProposalTarget } from "../db/schema/intake.ts";
import type { IntakeProposalItemView } from "./intake-types.ts";

export function proposalDigest(input: {
  title: string;
  body: string;
  target: IntakeProposalTarget;
  items: IntakeProposalItemView[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        items: [...input.items].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
