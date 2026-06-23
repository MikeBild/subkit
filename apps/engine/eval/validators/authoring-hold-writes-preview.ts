// Authoring scenario (Fix E / CI mode): side-effect-safe previews
// (Fix G). Previews default to hold-writes — read steps run live,
// write-classified steps (the POST/send) are fully RESOLVED from real
// upstream data but NEVER dispatched. Two layers pinned, both with the
// global-fetch egress tripwire at 0:
//
//   1. Engine contract (`runExecution` with `hold_writes`, the exact
//      call `dry_run_workflow` makes for a draft preview): the send
//      step carries `held: true` plus the MATERIALIZED `held_request`
//      (method/url/body with placeholders substituted against the live
//      transform output — the artifact the preview judge reads), and
//      the dependent step is labeled `skipped_dependency_held`.
//   2. Conversation surface (`dry_run_workflow`): the green
//      hold-preview marks the held step in its trace
//      (`request_meta.extras.held`), labels the dependent skipped, and
//      still auto-commits — "a green preview is the save" survives;
//      previews just no longer publish.

import { dryRunWorkflowTool } from "../../src/conversations/tools/dry-run-workflow.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import { runExecution } from "../../src/execution/engine.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Input {
  workflow_input: Record<string, unknown>;
  goal: string;
  steps: Array<Record<string, unknown>>;
  expect: {
    held_step: string;
    held_method: string;
    held_body_to: string;
    skipped_step: string;
    skipped_error_code: string;
  };
}

interface EnvelopeTraceEntry {
  step_id: string;
  status: string;
  error_code?: string;
  request_meta?: { extras?: { held?: boolean } };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("hold_writes", async (env) => {
    const c = new Checks();

    // ── 1. Engine contract: held + materialized + dependent skipped ──
    const { result: run, fetch_calls: engineFetchCalls } = await withEgressTripwire(() =>
      runExecution({
        db: env.db,
        tenant_id: env.tenant_id,
        source: {
          kind: "draft",
          definition: { name: "eval-hold-writes", slug: "eval-hold-writes", steps: input.steps },
        },
        input: input.workflow_input,
        options: { hold_writes: true },
      }),
    );
    c.check(
      engineFetchCalls === 0,
      `egress tripwire: ${engineFetchCalls} live HTTP attempt(s) in the held run`,
    );
    c.check(
      run.status === "succeeded",
      `hold-writes run status is ${run.status}, expected succeeded`,
    );

    const heldStep = run.steps.find((s) => s.step_key === input.expect.held_step);
    c.check(heldStep?.held === true, `step ${input.expect.held_step} was not held`);
    const held = heldStep?.held_request as
      | { method?: string; url?: string; body?: { to?: string } }
      | undefined;
    c.check(
      held?.method === input.expect.held_method,
      `held_request.method is ${String(held?.method)}, expected ${input.expect.held_method}`,
    );
    c.check(
      held?.body?.to === input.expect.held_body_to,
      `held_request.body was not MATERIALIZED from live upstream data (to=${String(held?.body?.to)})`,
    );
    const skippedStep = run.steps.find((s) => s.step_key === input.expect.skipped_step);
    c.check(
      (skippedStep?.error as { code?: string } | undefined)?.code ===
        input.expect.skipped_error_code,
      `dependent step carries ${String((skippedStep?.error as { code?: string } | undefined)?.code)}, expected ${input.expect.skipped_error_code}`,
    );
    if (c.failed) return { pass: false, reason: c.failed };

    // ── 2. Conversation surface: dry_run_workflow hold-preview ──
    // The draft carries a stashed goal so the post-preview judge runs and a
    // green hold-preview auto-commits (T4: auto-persist is gated on a judged
    // goal — a bare verification dry-run with no goal yields green_pending_save,
    // not a commit). The default mock judge passes (content-driven; override
    // only when asserting judge behaviour).
    const toolCtx = env.makeToolCtx({
      workflow: {
        name: "eval-hold-writes",
        slug: "eval-hold-writes",
        goal: input.goal,
        steps: input.steps,
      },
    } as unknown as DraftDocument);
    const { result, fetch_calls } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(toolCtx, { input: input.workflow_input }),
    );
    c.check(
      fetch_calls === 0,
      `egress tripwire: ${fetch_calls} live HTTP attempt(s) during the hold-preview`,
    );
    c.check(result.ok === true, "hold-writes preview did not come back green");
    const data = result.data as { auto_committed?: boolean; step_trace?: EnvelopeTraceEntry[] };
    const sendTrace = (data.step_trace ?? []).find((s) => s.step_id === input.expect.held_step);
    c.check(
      sendTrace?.request_meta?.extras?.held === true,
      "held step is not marked held in the dry_run trace",
    );
    const confirmTrace = (data.step_trace ?? []).find(
      (s) => s.step_id === input.expect.skipped_step,
    );
    c.check(
      confirmTrace?.error_code === input.expect.skipped_error_code,
      `dependent trace carries ${String(confirmTrace?.error_code)}, expected ${input.expect.skipped_error_code}`,
    );
    // Green + held + judged-against-a-goal still auto-commits (Fix G keeps the
    // save contract; T4 gates the auto-persist on that judged goal).
    c.check(data.auto_committed === true, "green hold-writes preview did not auto-commit");

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { fetch_calls: engineFetchCalls + fetch_calls } };
  });
}
