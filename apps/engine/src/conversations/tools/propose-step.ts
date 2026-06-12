// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens in example strings are the placeholder grammar surfaced to the LLM.
// propose_step — append a step to the draft and validate.
//
// The tool keeps a permissive zod inputSchema so the SDK always invokes
// our execute body. Strict validation runs inside via the workflow
// validator, and we craft a rich error payload (valid_kinds,
// required_fields_for_kind, example_for_kind) so the model can
// self-correct on the next iteration instead of guessing shapes.

import { z } from "@hono/zod-openapi";
import { type ValidationError, validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { emitRecordedEvalSignals, runRecordedEval } from "../recorded-eval.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import { evaluateAuthoringStageGate } from "./authoring-stage-gate.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { getLastPreview } from "./last-preview-store.ts";
import { collectProbedConnectorSlugs } from "./probed-connectors.ts";

const inputSchema = z
  .object({
    step: z.record(z.string(), z.unknown()),
  })
  .openapi("ProposeStepToolInput");

/** The LLM-facing palette: a deliberate SUBSET of `StepSchema`'s
 *  discriminator kinds. `wait_for_event` is omitted because the LLM
 *  can't reliably author it (it requires planning around external
 *  events the conversation hasn't seen). Exported so the schema-
 *  parity test in `apps/engine/src/workflows/types.test.ts` can
 *  fence drift: every kind here MUST exist in StepSchema. */
export const VALID_KINDS = [
  "request",
  "transform",
  "call",
  "wait",
  "branch",
  "parallel",
  "loop",
] as const;
type ValidKind = (typeof VALID_KINDS)[number];

const REQUIRED_FIELDS_PER_KIND: Record<ValidKind, string[]> = {
  request: ["id", "kind", "(url OR connector_id)"],
  transform: ["id", "kind", "expression"],
  call: ["id", "kind", "(workflow_id OR workflow_slug)"],
  wait: ["id", "kind", "duration_ms"],
  branch: ["id", "kind", "when", "then_steps"],
  parallel: ["id", "kind", "branches"],
  loop: ["id", "kind", "over", "body"],
};

const EXAMPLE_PER_KIND: Record<ValidKind, Record<string, unknown>> = {
  request: {
    id: "fetch_user",
    kind: "request",
    method: "GET",
    url: "https://api.example.com/users/${input.user_id}",
  },
  transform: {
    id: "shape_payload",
    kind: "transform",
    expression: '{ "name": $scope.fetch_user.data.name, "email": $scope.fetch_user.data.email }',
    language: "jsonata",
  },
  call: {
    id: "run_subflow",
    kind: "call",
    workflow_slug: "send-welcome-email",
    input: { email: "${scope.shape_payload.email}" },
  },
  wait: { id: "cooldown", kind: "wait", duration_ms: 5000 },
  branch: {
    id: "approve_or_reject",
    kind: "branch",
    when: "$scope.approval.data.outcome = 'approved'",
    then_steps: ["notify_approved"],
    else_steps: ["notify_rejected"],
  },
  parallel: {
    id: "fanout",
    kind: "parallel",
    branches: [["fetch_user"], ["fetch_orders"]],
  },
  loop: {
    id: "for_each_order",
    kind: "loop",
    over: "$scope.fetch_orders.data",
    body: ["process_order"],
  },
};

const DESCRIPTION = [
  "REPAIR-STAGE tool — apply a specific finding by appending/replacing ONE step in an already-designed draft; never use it for initial authoring (that is `author_workflow`, one call for the complete evaluated draft).",
  "Refuses with `authoring_stage_violation` while the draft has no recorded preview and no recorded-eval/judge findings.",
  "REQUIRED: each step has `id` (unique string) and `kind` (one of: request, transform, call, wait, branch, parallel, loop).",
  "Do NOT use `type`, `@type`, or invented kinds (`trigger.*`, `flow.*`, `util.*`). Those will fail.",
  "Placeholder grammar — only `${cred|connector|input|scope|item|...}`. Mustache `{{ ... }}` is rejected.",
  "Examples:",
  '- request: {"id":"fetch","kind":"request","method":"GET","url":"https://api.example.com/x"}',
  '- transform: {"id":"shape","kind":"transform","expression":"$scope.fetch.data.{ \\"name\\": name }","language":"jsonata"}',
  '- branch: {"id":"gate","kind":"branch","when":"$scope.fetch.data.x = true","then_steps":["a"],"else_steps":["b"]}',
  '- loop: {"id":"each","kind":"loop","over":"$scope.fetch.data","body":["body_step"]} — inside the body, address the current item as `$item` in JSONata and `${item.<path>}` in request strings (`item_var` is retired and rejected)',
  '- wait: {"id":"sleep","kind":"wait","duration_ms":5000}',
  "Returns ok=false with errors + valid_kinds + example_for_kind when the step is malformed; call propose_step again with the fixed shape.",
].join(" ");

function detectAttemptedKind(step: Record<string, unknown>): {
  attempted_kind: string | null;
  used_wrong_key: boolean;
} {
  if (typeof step.kind === "string") {
    return { attempted_kind: step.kind, used_wrong_key: false };
  }
  // Common LLM mistakes: `type`, `@type`, `step_type`. Surface them so the
  // model immediately understands which field name to use.
  for (const wrongKey of ["type", "@type", "step_type", "stepType"] as const) {
    const v = (step as Record<string, unknown>)[wrongKey];
    if (typeof v === "string") return { attempted_kind: v, used_wrong_key: true };
  }
  return { attempted_kind: null, used_wrong_key: false };
}

function isValidKind(k: string | null): k is ValidKind {
  return k !== null && (VALID_KINDS as readonly string[]).includes(k);
}

function buildErrorPayload(
  step: Record<string, unknown>,
  errors: ValidationError[],
  stepId: string | null,
): Record<string, unknown> {
  const { attempted_kind, used_wrong_key } = detectAttemptedKind(step);
  const validKind = isValidKind(attempted_kind) ? attempted_kind : null;
  const messageParts: string[] = ["step invalid"];
  if (used_wrong_key) {
    messageParts.push("you used the wrong key — the discriminator is `kind`, not `type` / `@type`");
  } else if (attempted_kind && !validKind) {
    messageParts.push(
      `\`${attempted_kind}\` is not a valid kind — pick one of: ${VALID_KINDS.join(", ")}`,
    );
  } else if (!attempted_kind) {
    messageParts.push(`missing required \`kind\` field — pick one of: ${VALID_KINDS.join(", ")}`);
  } else {
    messageParts.push(
      "fix the listed errors and call propose_step again (this tool is idempotent by id)",
    );
  }
  return {
    errors,
    step_id: stepId,
    attempted_kind,
    used_wrong_key,
    valid_kinds: [...VALID_KINDS],
    ...(validKind ? { required_fields_for_kind: REQUIRED_FIELDS_PER_KIND[validKind] } : {}),
    example_for_kind: validKind ? EXAMPLE_PER_KIND[validKind] : EXAMPLE_PER_KIND.request,
    message: messageParts.join(" — "),
  };
}

export const proposeStepTool: ConversationTool = {
  name: "propose_step",
  description: DESCRIPTION,
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    // Initial-stage gate (Fix A): micro-iteration is the repair flow,
    // not the authoring flow. See authoring-stage-gate.ts for the
    // predicate + deadlock-impossibility argument.
    const stageRefusal = await evaluateAuthoringStageGate(ctx, "propose_step");
    if (stageRefusal) return stageRefusal;
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const workflowDraft = structuredClone(getWorkflowDraft(currentDraft));
    const stepId = typeof args.step.id === "string" ? (args.step.id as string) : undefined;
    const existing = stepId ? workflowDraft.steps.findIndex((step) => step.id === stepId) : -1;
    if (stepId) {
      if (existing >= 0) {
        workflowDraft.steps[existing] = args.step;
      } else {
        workflowDraft.steps.push(args.step);
      }
    } else {
      workflowDraft.steps.push(args.step);
    }
    // Lenient mode: incremental authoring lets the LLM add a `loop`
    // step before its body steps exist. The dry-run / commit boundary
    // still rejects unresolved control-flow refs strictly.
    const validation = validateWorkflowDef(workflowDraft, { allowForwardRefs: true });
    if (!validation.ok) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "step_invalid",
          message: buildErrorPayload(args.step, validation.errors, stepId ?? null)
            .message as string,
          recommended_mode: "workflow",
          extra: buildErrorPayload(args.step, validation.errors, stepId ?? null),
        }),
      };
    }

    const nextDraft = withWorkflowDraft(currentDraft, workflowDraft, "workflow_step_updated");
    await ctx.setDraft(nextDraft);

    // Recorded-evaluation pass (Fix 9). The loop/transform authoring
    // gates used to REFUSE a loop/transform step whose upstream shape
    // was never recorded — that bounced the mutation and drove the
    // build → blocked → dry-run → rebuild thrash (sessions ebd66982 /
    // 86de186b / 784c1b02). The step is accepted now; the same gate
    // verdicts — plus JSONata compile caret errors and evaluation
    // against fingerprint-valid recorded evidence — come back as
    // findings in this result so the model repairs in the next call.
    // No live HTTP fires here; `dry_run_workflow` stays the explicit
    // live step.
    const probedConnectorSlugs = await collectProbedConnectorSlugs(ctx, workflowDraft.steps);
    const lastPreview = getLastPreview({
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
    });
    const recordedEval = await runRecordedEval(workflowDraft, {
      latest_preview: nextDraft.latest_preview ?? null,
      scope: lastPreview?.scope ?? null,
      input: lastPreview?.input ?? nextDraft.latest_preview?.input ?? null,
      probedConnectorSlugs,
    });
    emitRecordedEvalSignals({
      tool: "propose_step",
      conversation_id: ctx.conversation_id,
      report: recordedEval,
    });
    // Surface any pending forward references as an `info` hint so the
    // LLM knows which body steps it still has to add before the next
    // dry_run / commit. Pre-fix this was a hard error which made the
    // LLM give up and rewrite from scratch (session a53ae358 burned
    // 30+ tool results on three back-to-back forward-ref rejections).
    const forwardRefs = validation.forward_refs ?? [];
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          steps: workflowDraft.steps.length,
          step_id: stepId ?? null,
          step_type: typeof args.step.kind === "string" ? args.step.kind : null,
          replaced: stepId !== undefined && existing >= 0,
          last_step_id: workflowDraft.steps[workflowDraft.steps.length - 1]?.id ?? null,
          recorded_eval: recordedEval,
          ...(forwardRefs.length > 0
            ? {
                pending_forward_refs: forwardRefs,
                pending_forward_refs_message: `accepted with ${forwardRefs.length} unresolved control-flow target${
                  forwardRefs.length === 1 ? "" : "s"
                }: ${forwardRefs
                  .map((r) => `\`${r.step_id}\`.${r.field} → \`${r.ref}\``)
                  .join(
                    ", ",
                  )}. Add these step ids next via propose_step before the next dry_run / commit.`,
              }
            : {}),
        },
      }),
    };
  },
};
