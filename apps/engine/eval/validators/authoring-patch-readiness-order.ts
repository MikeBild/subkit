import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../../src/conversations/authoring-state.ts";
import { editWorkflowPatchTool } from "../../src/conversations/tools/edit-workflow-patch.ts";
import { saveWorkflowDraftTool } from "../../src/conversations/tools/save-workflow-draft.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks } from "./shared/authoring-env.ts";
import { makeOfflineToolCtx } from "./shared/offline-tool-ctx.ts";

interface Input {
  workflow: Record<string, unknown>;
  patches: Array<Record<string, unknown>>;
  expect: { readiness: Record<string, string>; save_order: string[] };
}

function checkedDraft(workflow: Record<string, unknown>): DraftDocument {
  const empty = createEmptyDraftDocument("workflow_authoring");
  const base = withWorkflowDraft(empty, { ...empty.workflow, ...workflow });
  const validated = withWorkflowValidation(withWorkflowInspection(base), true, "valid");
  return withLatestPreview(validated, {
    ok: true,
    summary: "preview ok",
  } as NonNullable<DraftDocument["latest_preview"]>);
}

function inOrder(text: string, names: string[]): boolean {
  let cursor = -1;
  for (const name of names) {
    const at = text.indexOf(name, cursor + 1);
    if (at <= cursor) return false;
    cursor = at;
  }
  return true;
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const toolCtx = makeOfflineToolCtx("patch_readiness", checkedDraft(input.workflow));
  const result = await editWorkflowPatchTool.execute(toolCtx, { patches: input.patches });
  c.check(result.ok, `valid patch was refused: ${JSON.stringify(result.data).slice(0, 300)}`);
  const readiness = (result.data as { readiness?: Record<string, string> } | undefined)?.readiness;
  c.check(readiness !== undefined, "patch result carries no readiness object");
  for (const [key, status] of Object.entries(input.expect.readiness)) {
    c.check(
      readiness?.[key] === status,
      `readiness.${key} ${readiness?.[key]} != ${status} (${JSON.stringify(readiness)})`,
    );
  }
  const notes = (saveWorkflowDraftTool.important_notes ?? []).filter((note) =>
    note.includes("readiness"),
  );
  c.check(notes.length > 0, "save_workflow_draft notes never mention readiness");
  c.check(
    notes.some((note) => inOrder(note, input.expect.save_order)),
    `save_workflow_draft notes do not state the order ${input.expect.save_order.join(" -> ")}`,
  );
  c.check(toolCtx.dbAccesses() === 0, "an auto-mode patch touched the database");
  if (c.failed) return { pass: false, reason: c.failed };
  return { pass: true };
}
