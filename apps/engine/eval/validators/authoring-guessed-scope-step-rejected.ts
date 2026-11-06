import {
  createEmptyDraftDocument,
  withWorkflowDraft,
} from "../../src/conversations/authoring-state/index.ts";
import { editWorkflowPatchTool } from "../../src/conversations/tools/edit-workflow-patch.ts";
import { validateDraftTool } from "../../src/conversations/tools/validate-draft.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks } from "./shared/authoring-env.ts";
import { makeOfflineToolCtx } from "./shared/offline-tool-ctx.ts";

interface Input {
  workflow: { steps: Array<Record<string, unknown>> } & Record<string, unknown>;
  guessed_url: string;
  expect: { path: string; message_fragments: string[]; patch_error_code: string };
}

interface Finding {
  path?: string;
  message?: string;
}

function draftWith(workflow: Record<string, unknown>): DraftDocument {
  const empty = createEmptyDraftDocument("workflow_authoring");
  return withWorkflowDraft(empty, { ...empty.workflow, ...workflow });
}

function findingsOf(data: unknown): Finding[] {
  const record = (data ?? {}) as { errors?: unknown };
  return Array.isArray(record.errors) ? (record.errors as Finding[]) : [];
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const readerIndex = input.workflow.steps.length - 1;
  const guessed = {
    ...input.workflow,
    steps: input.workflow.steps.map((step, index) =>
      index === readerIndex ? { ...step, url: input.guessed_url } : step,
    ),
  };

  const cleanCtx = makeOfflineToolCtx("scope_step_clean", draftWith(input.workflow));
  const clean = await validateDraftTool.execute(cleanCtx, {});
  c.check(
    clean.ok,
    `reference to the existing step was refused: ${JSON.stringify(findingsOf(clean.data)).slice(0, 300)}`,
  );

  const refusedCtx = makeOfflineToolCtx("scope_step_guessed", draftWith(guessed));
  const refused = await validateDraftTool.execute(refusedCtx, {});
  c.check(!refused.ok, "validate_draft accepted a placeholder on a guessed step id");
  const messages = findingsOf(refused.data)
    .filter((finding) => finding.path === input.expect.path)
    .map((finding) => finding.message ?? "");
  for (const fragment of input.expect.message_fragments) {
    c.check(
      messages.some((message) => message.includes(fragment)),
      `no finding on ${input.expect.path} names "${fragment}": ${JSON.stringify(messages)}`,
    );
  }

  const patchCtx = makeOfflineToolCtx("scope_step_patch", draftWith(input.workflow));
  const before = JSON.stringify(patchCtx.current().workflow);
  const patched = await editWorkflowPatchTool.execute(patchCtx, {
    patches: [{ op: "replace", path: `/steps/${readerIndex}/url`, value: input.guessed_url }],
  });
  const patchCode = (patched.data as { error_code?: string } | undefined)?.error_code;
  c.check(!patched.ok, "edit_workflow_patch introduced a placeholder on a guessed step id");
  c.check(
    patchCode === input.expect.patch_error_code,
    `patch error_code ${patchCode} != ${input.expect.patch_error_code}`,
  );
  c.check(
    JSON.stringify(patchCtx.current().workflow) === before,
    "a refused patch changed the draft",
  );

  const accesses = cleanCtx.dbAccesses() + refusedCtx.dbAccesses();
  c.check(accesses === 0, "validate_draft touched the database");
  if (c.failed) return { pass: false, reason: c.failed };
  return { pass: true };
}
