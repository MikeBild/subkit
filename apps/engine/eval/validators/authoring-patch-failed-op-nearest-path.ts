import {
  createEmptyDraftDocument,
  withWorkflowDraft,
} from "../../src/conversations/authoring-state/index.ts";
import { editWorkflowPatchTool } from "../../src/conversations/tools/edit-workflow-patch.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks } from "./shared/authoring-env.ts";
import { makeOfflineToolCtx } from "./shared/offline-tool-ctx.ts";

interface Input {
  workflow: Record<string, unknown>;
  patches: Array<Record<string, unknown>>;
  step_patches: Array<Record<string, unknown>>;
  expect: {
    error_code: string;
    failed_op_index: number;
    failed_op: { op: string; path: string };
    nearest_path: string;
    target_error_code: string;
    known_step_ids: string[];
  };
}

interface PatchFailure {
  error_code?: string;
  failed_op_index?: number | null;
  failed_op?: { op?: string; path?: string } | null;
  code?: string | null;
  nearest_path?: string | null;
  known_step_ids?: string[];
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const empty = createEmptyDraftDocument("workflow_authoring");
  const draft = withWorkflowDraft(empty, { ...empty.workflow, ...input.workflow });
  const ctx = makeOfflineToolCtx("patch_failed_op", draft);
  const before = JSON.stringify(ctx.current().workflow);

  const patched = await editWorkflowPatchTool.execute(ctx, { patches: input.patches });
  const data = (patched.data ?? {}) as PatchFailure;
  c.check(!patched.ok, "invalid patch was applied");
  c.check(
    data.error_code === input.expect.error_code,
    `error_code ${data.error_code} != ${input.expect.error_code}`,
  );
  c.check(
    data.failed_op_index === input.expect.failed_op_index,
    `failed_op_index ${data.failed_op_index} != ${input.expect.failed_op_index}`,
  );
  c.check(
    data.failed_op?.op === input.expect.failed_op.op &&
      data.failed_op?.path === input.expect.failed_op.path,
    `failed_op ${JSON.stringify(data.failed_op)} != ${JSON.stringify(input.expect.failed_op)}`,
  );
  c.check(typeof data.code === "string" && data.code.length > 0, "patch error code is missing");
  c.check(
    data.nearest_path === input.expect.nearest_path,
    `nearest_path ${data.nearest_path} != ${input.expect.nearest_path}`,
  );
  c.check(
    JSON.stringify(ctx.current().workflow) === before,
    "a refused patch changed the draft (partial application)",
  );

  const targeted = await editWorkflowPatchTool.execute(ctx, { step_patches: input.step_patches });
  const targetData = (targeted.data ?? {}) as PatchFailure;
  c.check(!targeted.ok, "step patch for an unknown step id was applied");
  c.check(
    targetData.error_code === input.expect.target_error_code,
    `step patch error_code ${targetData.error_code} != ${input.expect.target_error_code}`,
  );
  c.check(
    JSON.stringify(targetData.known_step_ids ?? []) === JSON.stringify(input.expect.known_step_ids),
    `known_step_ids ${JSON.stringify(targetData.known_step_ids)} != ${JSON.stringify(input.expect.known_step_ids)}`,
  );
  c.check(ctx.dbAccesses() === 0, "a refused patch touched the database");
  if (c.failed) return { pass: false, reason: c.failed };
  return { pass: true };
}
