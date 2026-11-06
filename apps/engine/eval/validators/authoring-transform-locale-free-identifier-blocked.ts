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
  broken_expression: string;
  expect: {
    path: string;
    message_fragments: string[];
    replacement_hint: string;
    patch_error_code: string;
  };
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
  const record = (data ?? {}) as { errors?: unknown; validation?: { errors?: unknown } };
  const errors = Array.isArray(record.errors)
    ? record.errors
    : Array.isArray(record.validation?.errors)
      ? record.validation.errors
      : [];
  return errors as Finding[];
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const transformIndex = input.workflow.steps.findIndex((step) => step.kind === "transform");
  const broken = {
    ...input.workflow,
    steps: input.workflow.steps.map((step, index) =>
      index === transformIndex ? { ...step, expression: input.broken_expression } : step,
    ),
  };

  const cleanCtx = makeOfflineToolCtx("transform_lint_clean", draftWith(input.workflow));
  const clean = await validateDraftTool.execute(cleanCtx, {});
  c.check(
    clean.ok,
    `clean sk.fmt transform was refused: ${JSON.stringify(clean.data).slice(0, 300)}`,
  );

  const brokenCtx = makeOfflineToolCtx("transform_lint_broken", draftWith(broken));
  const refused = await validateDraftTool.execute(brokenCtx, {});
  c.check(!refused.ok, "validate_draft accepted toLocaleDateString and an undeclared identifier");
  const messages = findingsOf(refused.data)
    .filter((finding) => finding.path === input.expect.path)
    .map((finding) => finding.message ?? "");
  for (const fragment of input.expect.message_fragments) {
    c.check(
      messages.some((message) => message.includes(fragment)),
      `no finding on ${input.expect.path} names "${fragment}": ${JSON.stringify(messages)}`,
    );
  }
  c.check(
    messages.some(
      (message) =>
        message.includes(input.expect.message_fragments[0] ?? "") &&
        message.includes(input.expect.replacement_hint),
    ),
    `the locale finding does not point at the ${input.expect.replacement_hint}* replacement`,
  );

  const patchCtx = makeOfflineToolCtx("transform_lint_patch", draftWith(input.workflow));
  const before = JSON.stringify(patchCtx.current().workflow);
  const patched = await editWorkflowPatchTool.execute(patchCtx, {
    patches: [
      {
        op: "replace",
        path: `/steps/${transformIndex}/expression`,
        value: input.broken_expression,
      },
    ],
  });
  const patchCode = (patched.data as { error_code?: string } | undefined)?.error_code;
  c.check(!patched.ok, "edit_workflow_patch introduced a transform the sandbox cannot run");
  c.check(
    patchCode === input.expect.patch_error_code,
    `patch error_code ${patchCode} != ${input.expect.patch_error_code}`,
  );
  c.check(
    JSON.stringify(patchCtx.current().workflow) === before,
    "a refused patch changed the draft",
  );

  const accesses = cleanCtx.dbAccesses() + brokenCtx.dbAccesses() + patchCtx.dbAccesses();
  c.check(accesses === 0, "the javascript lint path touched the database");
  if (c.failed) return { pass: false, reason: c.failed };
  return { pass: true };
}
