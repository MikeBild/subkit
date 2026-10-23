import {
  createEmptyDraftDocument,
  withWorkflowDraft,
} from "../../src/conversations/authoring-state.ts";
import { dryRunWorkflowTool } from "../../src/conversations/tools/dry-run-workflow.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withEgressTripwire } from "./shared/authoring-env.ts";
import { makeOfflineToolCtx } from "./shared/offline-tool-ctx.ts";

interface Input {
  canary: string;
  workflow: { steps: Array<Record<string, unknown>> } & Record<string, unknown>;
  broken_expression: string;
  expect: { mode: string; next_best_action: string };
}

interface SchemaOnlySummary {
  mode?: string;
  structure_checked?: boolean;
  content_checked?: boolean;
  content_withheld?: boolean;
  requests?: string;
  expressions?: Array<{ step_id?: string | null; status?: string }>;
}

interface PreviewData {
  schema_only_preview?: SchemaOnlySummary;
  next_best_actions?: string[];
  errors?: Array<{ path?: string }>;
}

function sensitiveDraft(workflow: Record<string, unknown>): DraftDocument {
  const empty = createEmptyDraftDocument("workflow_authoring");
  return withWorkflowDraft(empty, { ...empty.workflow, ...workflow });
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  let fetchCalls = 0;
  let dbAccesses = 0;

  {
    const ctx = makeOfflineToolCtx("sensitive_schema_only", sensitiveDraft(input.workflow));
    const { result, fetch_calls } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(ctx, {
        mode: input.expect.mode,
        input: { note: input.canary },
      }),
    );
    fetchCalls += fetch_calls;
    dbAccesses += ctx.dbAccesses();
    const data = (result.data ?? {}) as PreviewData;
    c.check(result.ok, `schema_only preview failed: ${JSON.stringify(result).slice(0, 300)}`);
    const summary = data.schema_only_preview;
    c.check(summary?.mode === input.expect.mode, `preview mode ${summary?.mode}`);
    c.check(summary?.structure_checked === true, "structure_checked is not true");
    c.check(summary?.content_checked === false, "content_checked is not false");
    c.check(summary?.content_withheld === true, "content_withheld is not true");
    c.check(summary?.requests === "held", `requests ${summary?.requests} != held`);
    c.check(
      (data.next_best_actions ?? []).includes(input.expect.next_best_action),
      `next_best_actions ${JSON.stringify(data.next_best_actions)} lacks ${input.expect.next_best_action}`,
    );
    const preview = ctx.current().latest_preview as
      | (Record<string, unknown> & { redacted?: boolean })
      | null
      | undefined;
    c.check(preview?.redacted === true, "preview checkpoint is not marked redacted");
    c.check(
      !JSON.stringify(result).includes(input.canary),
      "the sensitive input value reached the tool result",
    );
    c.check(
      !JSON.stringify(ctx.current()).includes(input.canary),
      "the sensitive input value was stored in the draft",
    );
  }

  {
    const steps = input.workflow.steps.map((step) =>
      step.kind === "transform" ? { ...step, expression: input.broken_expression } : step,
    );
    const ctx = makeOfflineToolCtx(
      "sensitive_schema_only_broken",
      sensitiveDraft({ ...input.workflow, steps }),
    );
    const { result, fetch_calls } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(ctx, { mode: input.expect.mode }),
    );
    fetchCalls += fetch_calls;
    dbAccesses += ctx.dbAccesses();
    const transformId = String(steps.find((step) => step.kind === "transform")?.id ?? "");
    const brokenPath = `steps.${transformId}.expression`;
    const errors = ((result.data as PreviewData | undefined)?.errors ?? []).map((e) => e.path);
    const findings = (result.data as PreviewData | undefined)?.schema_only_preview?.expressions;
    const named =
      errors.includes(brokenPath) ||
      (findings ?? []).some((f) => f.step_id === transformId && f.status === "compile_error");
    c.check(!result.ok, "a transform that does not compile passed the schema_only preview");
    c.check(named, `the refusal does not name ${brokenPath}: ${JSON.stringify(result.data)}`);
    c.check(
      !JSON.stringify(result).includes(input.canary),
      "the sensitive input value reached the repair result",
    );
  }

  c.check(fetchCalls === 0, `schema_only preview attempted ${fetchCalls} live request(s)`);
  c.check(dbAccesses === 0, "schema_only preview touched the database");
  if (c.failed) return { pass: false, reason: c.failed };
  return { pass: true, metrics: { fetch_calls: fetchCalls } };
}
