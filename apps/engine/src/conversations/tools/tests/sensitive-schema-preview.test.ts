import { describe, expect, test } from "bun:test";
import { normalizeDraftDocument } from "../../authoring-state.ts";
import { saveVerificationEvidence } from "../../handoff-summary.ts";
import { stepFingerprint } from "../../step-fingerprint.ts";
import type { DraftDocument } from "../../types.ts";
import { dryRunWorkflowTool } from "../dry-run-workflow.ts";
import type { ToolContext } from "../index.ts";
import {
  SENSITIVE_LIVE_VERIFICATION_HANDOFF,
  sensitiveExecutionUnsupported,
} from "../sensitive-envelope.ts";
import { runSensitiveSchemaPreview } from "../sensitive-schema-preview.ts";
import { suggestJsonataPathsTool } from "../suggest-jsonata-paths.ts";

const PLANTED = "planted-sensitive-value-7f3a";

const fetchStep = {
  id: "fetch",
  kind: "request",
  method: "GET",
  url: "https://example.com/items",
};

function transformStep(expression: string) {
  return { id: "shape", kind: "transform", language: "javascript", expression };
}

function sensitiveDraft(
  expression: string,
  privacy: "sensitive" | null = "sensitive",
): DraftDocument {
  const steps = [fetchStep, transformStep(expression)];
  return {
    workflow: {
      name: "sensitive-schema",
      ...(privacy ? { execution_privacy: privacy } : {}),
      steps,
    } as never,
    latest_preview: {
      ok: true,
      summary: "earlier preview",
      input: { secret: PLANTED },
      step_traces: [
        {
          step_id: "fetch",
          kind: "request",
          status: "succeeded",
          fingerprint: stepFingerprint(fetchStep),
          output_preview: { items: [{ email: PLANTED }] },
        },
      ],
    },
  };
}

function makeCtx(draft: DraftDocument) {
  let current = draft;
  const writes: DraftDocument[] = [];
  const ctx = {
    db: {} as ToolContext["db"],
    tenant_id: "00000000-0000-0000-0000-000000000000",
    conversation_id: "11111111-1111-1111-1111-111111111111",
    actor_id: "00000000-0000-4000-8000-000000000084",
    principal: {
      provider: "test",
      tenant_id: "00000000-0000-0000-0000-000000000000",
      id: "00000000-0000-4000-8000-000000000084",
      kind: "user",
      roles: ["admin"],
    },
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => current,
    setDraft: async (next: DraftDocument) => {
      current = next;
      writes.push(next);
    },
  } as ToolContext;
  return { ctx, writes, current: () => current };
}

function definitionOf(draft: DraftDocument) {
  return draft.workflow as never;
}

describe("schema-only preview of a sensitive draft", () => {
  test("records a redacted previewed checkpoint without returning or storing any value", async () => {
    const draft = sensitiveDraft("return input.scope.fetch.data.items;");
    const { ctx, writes, current } = makeCtx(draft);
    const result = await runSensitiveSchemaPreview({ ctx, definition: definitionOf(draft) });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain(PLANTED);

    const stored = normalizeDraftDocument(JSON.parse(JSON.stringify(current())));
    expect(stored.latest_preview?.redacted).toBe(true);
    expect(stored.latest_preview?.mode).toBe("schema_only");
    expect(stored.latest_preview?.step_traces ?? []).toHaveLength(0);
    expect(stored.latest_preview?.input).toBeNull();
    expect(stored.state?.checkpoints.workflow_previewed).toMatchObject({
      ok: true,
      redacted: true,
      verified_by_tool: "dry_run_workflow",
    });
    expect(stored.state?.checkpoints.workflow_validated?.ok).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(PLANTED);

    const data = result.data as Record<string, unknown>;
    const summary = data.schema_only_preview as Record<string, unknown>;
    expect(summary).toMatchObject({
      mode: "schema_only",
      status: "passed",
      structure_checked: true,
      content_checked: false,
      requests: "held",
    });
    expect(String(data.summary)).toContain("Structure checked, content not checked.");
    expect(data.handoff).toBe(SENSITIVE_LIVE_VERIFICATION_HANDOFF);
    expect(JSON.stringify(summary)).not.toContain("value_preview");
    expect(JSON.stringify(summary)).not.toContain("path_candidates");
  });

  test("satisfies the sensitive save evidence only for a sensitive draft", async () => {
    const draft = sensitiveDraft("return input.scope.fetch.data.items;");
    const { ctx, current } = makeCtx(draft);
    await runSensitiveSchemaPreview({ ctx, definition: definitionOf(draft) });
    expect(saveVerificationEvidence(current(), false).preview).toBe("passed_schema_only");

    const widened = {
      ...current(),
      workflow: { ...current().workflow, execution_privacy: undefined },
    } as DraftDocument;
    expect(saveVerificationEvidence(widened, false).preview).toBe("missing");
  });

  test("a compile error fails the check and still returns no value", async () => {
    const draft = sensitiveDraft("return items[;");
    const { ctx, current } = makeCtx(draft);
    const result = await runSensitiveSchemaPreview({ ctx, definition: definitionOf(draft) });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error_code).toBe("preview_needs_repair");
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    const summary = (result.data as Record<string, unknown>).schema_only_preview as {
      status: string;
      counts: { compile_errors: number };
    };
    expect(summary.status).toBe("failed");
    expect(summary.counts.compile_errors).toBe(1);
    expect(current().state?.checkpoints.workflow_previewed).toMatchObject({
      ok: false,
      redacted: true,
    });
  });

  test("dry_run_workflow refuses schema_only for a draft that is not sensitive", async () => {
    const draft = sensitiveDraft("return 1;", null);
    const { ctx, writes } = makeCtx(draft);
    const result = await dryRunWorkflowTool.execute(ctx, { mode: "schema_only" });
    expect(result).toMatchObject({
      ok: false,
      error_code: "schema_only_requires_sensitive_draft",
    });
    expect(writes).toHaveLength(0);
  });
});

describe("sensitive_execution_unsupported envelope", () => {
  test("carries the next actions and the Cockpit handoff", () => {
    const result = sensitiveExecutionUnsupported();
    expect(result).toMatchObject({
      ok: false,
      error_code: "sensitive_execution_unsupported",
      next_best_actions: ["inspect_workflow_draft", "validate_draft"],
      data: {
        error_code: "sensitive_execution_unsupported",
        content_withheld: true,
        next_best_actions: ["inspect_workflow_draft", "validate_draft"],
        handoff: SENSITIVE_LIVE_VERIFICATION_HANDOFF,
      },
    });
  });

  test("suggest_jsonata_paths returns the shared envelope for a sensitive draft", async () => {
    const draft = sensitiveDraft("return 1;");
    const { ctx } = makeCtx(draft);
    const suggested = await suggestJsonataPathsTool.execute(ctx, { step_id: "fetch" });
    expect(suggested).toMatchObject({
      ok: false,
      error_code: "sensitive_execution_unsupported",
      next_best_actions: ["inspect_workflow_draft", "validate_draft"],
      data: { handoff: SENSITIVE_LIVE_VERIFICATION_HANDOFF },
    });
    expect(JSON.stringify(suggested)).not.toContain(PLANTED);
  });
});
