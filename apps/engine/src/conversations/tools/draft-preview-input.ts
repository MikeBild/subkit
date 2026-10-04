import type { Executor } from "../../db/client.ts";
import { workflowPreparationInput } from "../../workflows/preparation-input.ts";
import type { DraftDocument } from "../types.ts";
import { getAuthoringSnapshot } from "./authoring-contract.ts";

export async function draftPreviewInput(
  db: Executor,
  tenantId: string,
  draft: DraftDocument,
  environment: "dev" | "prod",
  input: unknown,
): Promise<unknown> {
  if (input !== undefined) return input;
  const target = getAuthoringSnapshot(draft).summary?.active_target;
  if (target?.kind !== "workflow" || !target.id) return undefined;
  return workflowPreparationInput(db, tenantId, target.id, environment, { execute_writes: false });
}
