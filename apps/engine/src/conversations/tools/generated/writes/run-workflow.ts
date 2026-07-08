// run_workflow tool — executes a workflow synchronously in the tenant's
// dev environment (unless the caller opts into prod). Writes an audit
// entry on each attempt.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import {
  conversations,
  conversationToolCalls,
  workflowVersions,
} from "../../../../db/schema/index.ts";
import { runExecution } from "../../../../execution/engine.ts";
import { logger } from "../../../../logging/logger.ts";
import { recordAuthoringGateBlock } from "../../../../observability/instrumentation.ts";
import { resolveWorkflowInputContract } from "../../../../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../../../../workflows/lookup.ts";
import { gateWorkflowRunRbac } from "../../../../workflows/rbac.ts";
import { buildScopeAtStep } from "../../../../workflows/scope-shape.ts";
import type { WorkflowDef } from "../../../../workflows/types.ts";
import {
  bindPersistedWorkflow,
  getWorkflowDraft,
  withLatestPreview,
  withWorkflowExecution,
} from "../../../authoring-state.ts";
import { stampStepTraceFingerprints } from "../../../step-fingerprint.ts";
import { pauseForUserInput } from "../../ask-user/common.ts";
import { buildGateError, buildLifecyclePayload } from "../../authoring-contract.ts";
import type { ConversationTool } from "../../index.ts";
import { buildRawStepResults } from "../../step-results.ts";
import { sampleWorkflowOutputForLlm, truncateStepPreviewForLlm } from "../../truncate.ts";
import { normalizeWorkflowInput } from "../../workflow-input-normalize.ts";
import { type RepairLoopVerdict, tallyRepairSignals } from "./repair-loop-tally.ts";

/**
 * Circuit-breaker for repair loops. Fetches the recent tool-call history
 * for this conversation and delegates to `tallyRepairSignals`, which
 * counts two trip signals (a repeating authoring-bug warning code, and a
 * repeating runtime execution failure keyed on `exec_failed:<step>:<code>`)
 * and refuses the run when either reaches the threshold — instead of
 * burning the rest of the step budget on a draft that won't work.
 */
async function detectRepairLoop(
  db: ReturnType<typeof eq> extends never ? never : import("../../../../db/client.ts").Db,
  tenant_id: string,
  conversation_id: string,
): Promise<RepairLoopVerdict> {
  try {
    const rows = await db
      .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, tenant_id),
          eq(conversationToolCalls.conversation_id, conversation_id),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(8);
    return tallyRepairSignals(rows);
  } catch {
    return { tripped: false, recent_codes: [], tripped_codes: [] };
  }
}

/**
 * The workflow's `$input` map. Typed as an OBJECT on the wire — a bare
 * `z.unknown()` emits the empty JSON Schema `{}`, which tells a client
 * nothing and therefore invites it to serialize the map into a string.
 *
 * The union accepts a stringified object too, but only as a TOLERANCE: the
 * transform normalizes it back to a record, and the `.pipe()` re-validates
 * so the emitted output-side schema (mcp/json-schema.ts uses
 * `pipeStrategy: "output"`) is a plain object — never a `{}`, never an
 * `anyOf` that reads as "a string is fine here". Same shape as the
 * `policyMarkerSchema` union+transform in sdk-wrap/invoke.ts: accept both
 * representations at the boundary, hand exactly one downstream.
 *
 * A string that is not a JSON object literal is a hallucinated input map
 * (`input: "tomorrow"`), and is rejected here rather than travelling to the
 * execution engine to fail as `$input: required field '<k>' is missing`.
 */
const workflowInputSlot = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .transform((raw, ctx) => {
    const normalized = normalizeWorkflowInput(raw);
    if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
    // `input: ""` unambiguously means "no input" — treat it as the empty map
    // instead of failing the call.
    if (typeof normalized === "string" && normalized.trim() === "") return {};
    ctx.addIssue({
      code: "custom",
      message:
        'input must be the workflow\'s input map (a JSON object), e.g. {"city":"Berlin"} — not a bare string',
    });
    return z.NEVER;
  })
  .pipe(z.record(z.string(), z.unknown()));

const Input = z
  .object({
    // Accepts a slug (kebab-case identifier from the tenant snapshot) or
    // a uuid. `.min(1)` rejects empty / whitespace-only strings that an
    // LLM might emit instead of failing later at `resolveWorkflowByIdOrSlug`;
    // `.max(256)` is a defensive cap (slugs are short, uuids are 36
    // chars, anything beyond is a hallucination).
    workflow: z.string().min(1).max(256).optional(),
    input: workflowInputSlot.optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    /**
     * When true, the result envelope always includes a `step_trace`
     * array (one entry per step: status, kind, duration_ms,
     * request_meta, output_preview, error_code). Default behaviour still
     * attaches the trace on failure / partial / warnings, so leaving
     * this off costs nothing on the happy path.
     */
    include_step_trace: z.boolean().optional(),
    /**
     * When true, attach a `step_results` array carrying the RAW per-step
     * input (the resolved request each step issued, or the held request for
     * a write) side-by-side with its output. Default false keeps the
     * envelope compact. The model uses this to self-diagnose whether a bad
     * output is a step-config bug (the request went out wrong) or an
     * output_transform bug (the step was fine, the projection dropped it).
     * Reuses the same offload/raw-ref machinery as `step_trace` — no new
     * store.
     */
    include_step_results: z.boolean().optional(),
    /**
     * side-effect safety. By DEFAULT a `run_workflow` from the
     * authoring surface HOLDS write-classified steps (sends, POST/PUT/
     * DELETE, non-SELECT SQL/GraphQL mutations): they are fully resolved
     * (URL/headers/body materialized) but NOT dispatched, so verifying a
     * saved workflow during authoring can never fire a real email/write.
     * Set `execute_writes: true` ONLY when the user explicitly asked for a
     * real, live run. It is a request for the operator's approval, not an
     * approval: the call pauses on a confirmation the operator answers, and
     * the engine performs the writes itself. It is never a way to run them
     * yourself. The scheduler and the HTTP run endpoint are unaffected (they
     * never route through this tool), so production runs still send.
     */
    execute_writes: z.boolean().optional(),
  })
  .openapi("RunWorkflowToolInput");

/**
 * The canonical args, post-parse. The dispatcher (and, on the chat loop, the
 * AI SDK's tool boundary) parses `Input` before `execute` is reached, so this
 * executor takes the parsed value as-is. `workflowInputSlot` is the transform
 * whose OUTPUT `requestApproval` persists; `schema-idempotence.test.ts` pins it
 * idempotent so replaying that value through `Input` cannot rewrite it.
 */
type RunWorkflowArgs = z.infer<typeof Input>;

/**
 * Terminal status the CLI must always see for a `run_workflow` result.
 * Missing this field is what produced the "Execution status missing
 * from engine — bug, not a state" UI in session 79bf2cca; the gate
 * error returns went through `buildGateError` which has no status
 * field. We close the contract here at the tool boundary instead of
 * trusting every callsite.
 */
type RunWorkflowStatus = "succeeded" | "failed" | "partial_success";

function withStatus(
  data: Record<string, unknown>,
  status: RunWorkflowStatus,
): Record<string, unknown> {
  // If a caller already set a more specific status (e.g. the lifecycle
  // path passes "succeeded"/"partial_success" via buildLifecyclePayload's
  // extra), keep it. Otherwise stamp the supplied default.
  if (typeof data.status === "string") return data;
  return { ...data, status };
}

export const runWorkflowTool: ConversationTool = {
  name: "run_workflow",
  description:
    "FALLBACK for executing an ALREADY-SAVED workflow. Prefer the `wf_<slug>` tool when the workflow has an input schema — that tool already carries the schema. Use `run_workflow` only when you have a UUID, when the workflow is not in the `wf_` catalog, or when running the workflow most recently bound to this conversation. Accepts `workflow` as a slug or UUID. WRITE-classified steps (email sends, posts, publishes) are HELD by default — resolved but NOT dispatched — so a run is side-effect-safe; the envelope reports `writes_held` + `held_step_ids`. A live send is the operator's decision: pass `execute_writes: true` only when the user explicitly asked for one, and understand that it raises an approval the operator answers rather than performing the writes. To verify a DRAFT, use `dry_run_workflow`, never `run_workflow`. Never call `dry_run_workflow` on a saved workflow — that is for drafts only. Do NOT use `run_workflow` to build/create/test a NEW workflow (even if the user pasted example data or JSONata) — that is authoring intent: call `author_workflow` (then `edit_workflow_patch` for edits).",
  inputSchema: Input,
  category: "tenant_write",
  requires_persisted_workflow: true,
  async execute(ctx, args: RunWorkflowArgs) {
    const currentDraft = ctx.getDraft();
    const activeTarget = currentDraft.summary?.active_target ?? null;
    let workflowId: string | null = null;
    if (args.workflow) {
      const resolved = await resolveWorkflowByIdOrSlug(ctx.db, ctx.tenant_id, args.workflow);
      if (!resolved) {
        return {
          ok: false,
          data: withStatus(
            {
              error_code: "workflow_not_found",
              message: `no workflow matched the reference '${args.workflow}' — pass a slug or UUID from the TENANT SNAPSHOT block`,
              next_best_actions: ["list_workflows", "find_workflow"],
            },
            "failed",
          ),
        };
      }
      workflowId = resolved.id;
    } else if (activeTarget?.kind === "workflow" && activeTarget.lifecycle_state === "persisted") {
      workflowId = activeTarget.id;
    }
    if (!workflowId) {
      // Disambiguate the two ways we can land here:
      //   (a) there IS a draft in progress → the author just needs to
      //       commit it (save_workflow_draft / dry_run_workflow auto-commit).
      //   (b) there is NO draft yet → the user asked to BUILD a workflow and
      //       the model wrongly reached for run_workflow. Without a redirect
      //       to build_workflow the model retries run_workflow with variant
      //       args until the loop-detector aborts the turn (observed in prod:
      //       run_workflow → workflow_not_persisted ×3 → tool.loop_detected,
      //       ~150k tokens/turn). Route it to the authoring tools instead.
      const draftSteps = getWorkflowDraft(currentDraft).steps;
      const hasDraftSteps = Array.isArray(draftSteps) && draftSteps.length > 0;
      const message = hasDraftSteps
        ? "commit the workflow before running it from the conversation surface"
        : "there is no workflow to run yet — author one first. If the user asked to BUILD or CREATE a workflow, call author_workflow (the one-shot grounded builder). run_workflow only executes a workflow that has already been authored and saved.";
      const next_best_actions = hasDraftSteps
        ? ["dry_run_workflow", "save_workflow_draft"]
        : ["author_workflow"];
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "workflow_not_persisted",
            message,
            recommended_mode: "workflow",
            stale_checkpoints: ["workflow_persisted"],
            next_best_actions,
          }),
          "failed",
        ),
      };
    }
    const wf = await ctx.engineClient.workflows.get(workflowId);
    if (!wf) return { ok: false, data: withStatus({ error: "workflow_not_found" }, "failed") };
    // G1 (runtime-logs review plan): surface the workflow's input_schema
    // contract to the LLM in the SAME turn. Pre-fix the user asked
    // "run it for tomorrow" and the workflow returned byte-identical
    // output because the date was hardcoded in the request URL — no
    // input parameter existed but the model never told the user that.
    // Two arms:
    //   (a) workflow declares input_schema but the run is missing
    //       inputs — pause with an auto-generated ask_user_form built
    //       from the schema (already-supplied values pre-filled as
    //       defaults), instead of an `input_required` error the LLM
    //       had to hand-translate into a form. On resume the LLM
    //       re-issues run_workflow with the submitted answers.
    //   (b) workflow has NO input contract at all but caller passed
    //       non-empty input — execute, but include `input_ignored:
    //       true` in the success envelope so the LLM knows to tell
    //       the user the value was discarded.
    // The contract is the DECLARED `input_schema` when present, else
    // the schema SYNTHESIZED from `${input.*}` placeholders — the same
    // source the `wf_<slug>` tool schema and the usage block read, so
    // the gate can never disagree with the published input contract.
    // (Pre-fix a placeholder-driven workflow without a declared schema
    // skipped the gate and failed at runtime with
    // "$input: required field '<k>' is missing".)
    const inputContract = resolveWorkflowInputContract(wf.definition as WorkflowDef);
    // `workflowInputSlot` normalized the slot to a record (or left it absent)
    // at the dispatch boundary — a stringified payload can no longer reach here.
    const suppliedInput = args.input;
    const suppliedInputIsEmpty =
      suppliedInput === undefined || Object.keys(suppliedInput).length === 0;
    if (inputContract) {
      const properties =
        inputContract.schema.properties && typeof inputContract.schema.properties === "object"
          ? (inputContract.schema.properties as Record<string, unknown>)
          : {};
      const propertyNames = inputContract.properties;
      const requiredKeys = inputContract.required;
      const suppliedMap = suppliedInput ?? {};
      const missingRequired = requiredKeys.filter((k) => {
        const v = suppliedMap[k];
        return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
      });
      if ((suppliedInputIsEmpty || missingRequired.length > 0) && propertyNames.length > 0) {
        const requiredSet = new Set(requiredKeys);
        const fields = propertyNames.map((name) => {
          const prop =
            properties[name] && typeof properties[name] === "object"
              ? (properties[name] as Record<string, unknown>)
              : {};
          const type =
            prop.type === "number" || prop.type === "integer"
              ? ("number" as const)
              : prop.type === "boolean"
                ? ("boolean" as const)
                : ("text" as const);
          const supplied = suppliedMap[name];
          const fallbackDefault = prop.default;
          const defaultValue =
            typeof supplied === "string" ||
            typeof supplied === "number" ||
            typeof supplied === "boolean"
              ? supplied
              : typeof fallbackDefault === "string" ||
                  typeof fallbackDefault === "number" ||
                  typeof fallbackDefault === "boolean"
                ? fallbackDefault
                : undefined;
          return {
            name,
            label: name,
            type,
            required: requiredSet.has(name),
            ...(typeof prop.description === "string" ? { placeholder: prop.description } : {}),
            ...(defaultValue !== undefined ? { default: defaultValue } : {}),
          };
        });
        logger.info({
          module: "conversation_tool",
          action: "run_workflow.input_form_elicited",
          msg: "run_workflow paused with an auto-generated input form",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          workflow_slug: wf.slug,
          missing_required: missingRequired,
        });
        return pauseForUserInput(ctx, {
          tool_name: "ask_user_form",
          summary: `Workflow "${wf.slug}" needs input before it can run`,
          input: {
            question: `Workflow "${wf.slug}" needs the following input${fields.length === 1 ? "" : "s"} to run:`,
            fields,
            // The harness executes the run with the submitted values on
            // form submit (see auto-persist's run_workflow case) — the
            // LLM is NOT trusted to re-issue run_workflow with the
            // answers; observed live it re-called with empty input and
            // looped back into the same form.
            commit_intent: {
              kind: "run_workflow",
              payload: {
                workflow_id: workflowId,
                workflow_slug: wf.slug,
                environment: args.environment,
                input_partial: suppliedMap,
              },
              description: `Run workflow "${wf.slug}" with the submitted input`,
            },
          },
        });
      }
    }
    const inputIgnored = inputContract === null && !suppliedInputIsEmpty;
    if (
      activeTarget?.kind === "workflow" &&
      activeTarget.lifecycle_state === "draft_only" &&
      !args.workflow
    ) {
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "workflow_not_persisted",
            message: "commit the current workflow draft before running it",
            recommended_mode: "workflow",
            stale_checkpoints: ["workflow_persisted"],
          }),
          "failed",
        ),
      };
    }

    // Circuit-breaker: refuse to run when the same trip signal has fired
    // three times in this conversation — either a repeating authoring-bug
    // warning code (unresolved_identifier, loop_over_unresolved,
    // transform_empty_extraction) OR the same runtime execution failure
    // (exec_failed:<step>:<error_code>). The LLM is chasing a fix that
    // isn't working; another run won't tell it anything new and burns the
    // rest of the step budget.
    const breaker = await detectRepairLoop(ctx.db, ctx.tenant_id, ctx.conversation_id);
    if (breaker.tripped) {
      logger.warn({
        module: "conversation_tool",
        action: "run_workflow.repair_loop_detected",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        recent_codes: breaker.recent_codes,
        tripped_codes: breaker.tripped_codes,
      });
      recordAuthoringGateBlock({ code: "repair_loop_detected", tool: "run_workflow" });
      const codesPretty = breaker.tripped_codes.map((c) => `\`${c.code}\` × ${c.count}`).join(", ");
      const execFailureTrip = breaker.tripped_codes.some((c) => c.code.startsWith("exec_failed:"));
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "repair_loop_detected",
            message: execFailureTrip
              ? `stop — this workflow has failed at runtime three or more times with the same error: ${codesPretty}. Re-running the same draft will fail the same way. Run \`diagnose_latest_execution\` to read the failing step, then fix the actual cause or ask the user what they want — do NOT re-run this draft unchanged. A common cause: a request step calls an endpoint that rejects the value you pass (many APIs have no "by-name" lookup and need a search/resolve step that turns the name into an id first).`
              : `stop — three or more consecutive runs of this workflow surfaced the same authoring-bug warning(s): ${codesPretty}. The current strategy is not working. Read \`data-handling.md\` and \`workflow-authoring.md\` for the loop+JSONata scope rules, ask the user what output they actually want, and propose a structurally different draft. Re-running this one will produce the same warning.`,
            recommended_mode: "diagnosis",
            next_best_actions: [
              "ask_user_text",
              "diagnose_latest_execution",
              "inspect_workflow_draft",
              "load_skill",
              "search_knowledge",
            ],
            extra: {
              recent_warning_codes: breaker.recent_codes,
              tripped_codes: breaker.tripped_codes,
            },
          }),
          "failed",
        ),
      };
    }

    try {
      // Canonical RBAC gate — identical contract to MCP's `wf_<slug>`,
      // the fast-path "run <slug>" branch, and the synthetic palette.
      // POLICY_DENIED audit row is committed inside the helper. Principal
      // is REQUIRED — production callers always thread it; in-process
      // workers and test fixtures must seed a system principal. A null
      // here refuses (instead of silently bypassing RBAC) so a future
      // caller that forgets to wire principal fails loudly.
      if (!ctx.principal) {
        logger.warn({
          module: "conversation_tool",
          action: "run_workflow.no_principal",
          msg: "run_workflow invoked without ctx.principal — refusing rather than bypassing RBAC",
          tenant_id: ctx.tenant_id,
          workflow_id: workflowId,
        });
        // Surface the refusal as a counter so SRE can alert on a future
        // regression that silently drops `ctx.principal`. `logger.warn`
        // alone is invisible to the existing dashboards.
        recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
        return {
          ok: false,
          data: withStatus(
            {
              error_code: "principal_required",
              message:
                "run_workflow requires an authenticated principal on the ToolContext; production callers must thread it from the auth resolution.",
              workflow_slug: wf.slug,
            },
            "failed",
          ),
        };
      }
      const rbac = await gateWorkflowRunRbac({
        db: ctx.db,
        principal: ctx.principal,
        workflow_id: workflowId,
        workflow_slug: wf.slug,
        request_source: "chat",
        tool: "run_workflow",
      });
      if (!rbac.allow) {
        return {
          ok: false,
          data: withStatus(
            {
              error_code: "permission_denied",
              permission: "workflow:run",
              reason: rbac.reason,
              message: rbac.error_message,
              workflow_slug: wf.slug,
            },
            "failed",
          ),
        };
      }
      ctx.onLog?.(
        "info",
        `running workflow ${wf.slug} (v${wf.current_version}) in env=${args.environment}`,
      );
      // hold write-classified steps unless the caller explicitly opted
      // into a live run. The engine resolves writes (materializes the
      // would-be request) but does not dispatch them, so an authoring-time
      // verification of a saved workflow cannot fire a real send.
      const holdWrites = args.execute_writes !== true;
      const result = await runExecution({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        source: { kind: "saved", workflow_id: workflowId },
        input: suppliedInput ?? null,
        options: {
          request_source: "chat",
          trace_id: null,
          principal: ctx.principal,
          execution_mode: args.environment,
          ...(holdWrites ? { hold_writes: true } : {}),
        },
      });
      // A held write step carries `held: true` (it resolved but did not
      // dispatch); a downstream step blocked by the hold is `skipped` with
      // code `skipped_dependency_held`. Both count as "not actually run".
      const heldStepIds = holdWrites
        ? result.steps
            .filter(
              (s) =>
                (s as { held?: boolean }).held === true ||
                (s.error &&
                  typeof s.error === "object" &&
                  (s.error as { code?: unknown }).code === "skipped_dependency_held"),
            )
            .map((s) => s.step_key)
        : [];
      // Emit per-step progress logs so the user sees what each step
      // did during the run (status, kind, duration). Without this the
      // chat shows a single "Execution complete" badge and the loop's
      // empty body is invisible.
      for (const step of result.steps) {
        const errMsg =
          step.error && typeof step.error === "object" && step.error !== null
            ? (step.error as { message?: unknown }).message
            : null;
        const level: "info" | "warn" | "error" =
          step.status === "succeeded"
            ? "info"
            : step.status === "failed" || step.status === "timed_out"
              ? "error"
              : "warn";
        ctx.onLog?.(
          level,
          `step ${step.step_key} (${step.kind}) ${step.status}${
            step.duration_ms != null ? ` · ${step.duration_ms}ms` : ""
          }${typeof errMsg === "string" ? ` · ${errMsg}` : ""}`,
        );
      }
      for (const w of result.warnings ?? []) {
        ctx.onLog?.(
          "warn",
          `step ${w.step_key} · ${w.code}${w.identifier ? ` · ${w.identifier}` : ""} · ${w.message}`,
        );
      }
      await ctx.engineClient.audit_write({
        resource_type: "execution",
        resource_id: result.execution_id,
        action: "conversation.run_workflow",
        result: result.status === "succeeded" ? "success" : "error",
        metadata: {
          conversation_id: ctx.conversation_id,
          workflow_id: workflowId,
          environment: args.environment,
          final_status: result.status,
          // a held run vs a live (writes-dispatched) run must be
          // distinguishable in the audit log so "did this run actually
          // send?" is answerable.
          execute_writes: args.execute_writes === true,
          ...(heldStepIds.length > 0 ? { held_step_ids: heldStepIds } : {}),
        },
      });
      await ctx.db
        .update(conversations)
        .set({
          target_workflow_id: workflowId,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(conversations.tenant_id, ctx.tenant_id),
            eq(conversations.id, ctx.conversation_id),
          ),
        );
      // Surface non-fatal warnings (unresolved identifiers in transform
      // expressions, schema drift signals) so the LLM / operator sees
      // them next to the output. The execution may be technically
      // "succeeded" (no driver errors) but produced suspicious output:
      // - unresolved_identifier warnings → JSONata referenced names not
      //   in scope; output likely partial/null
      // - the workflow returned an empty array as top-level output
      //   from a step that fanned out (loop) → loop body never iterated
      // Both cases get tagged `partial_success` on the payload so the
      // CLI surfaces the warning treatment and the LLM is forced to
      // either repair or explicitly acknowledge the warning.
      const hasWarnings = (result.warnings?.length ?? 0) > 0;
      const hasUnresolvedIdentifierWarning = (result.warnings ?? []).some(
        (w) => w.code === "unresolved_identifier",
      );
      const hasTransformEmptyExtractionWarning = (result.warnings ?? []).some(
        (w) => w.code === "transform_empty_extraction",
      );
      const _hasTransformDroppedFieldsWarning = (result.warnings ?? []).some(
        (w) => w.code === "transform_dropped_fields",
      );
      const hasLoopOverUnresolvedWarning = (result.warnings ?? []).some(
        (w) => w.code === "loop_over_unresolved",
      );
      // The engine emits `loop_body_empty` from inside the loop driver
      // when iterations > 0 produced no productive body output (P2).
      // Trust that warning over the legacy "top-level output is []"
      // heuristic — the user's transcript had a populated top-level
      // output assembled by a transform AFTER the empty loop body, so
      // the legacy heuristic missed it.
      const hasLoopBodyEmptyWarning = (result.warnings ?? []).some(
        (w) => w.code === "loop_body_empty",
      );
      const loopStepRanWithEmptyBody =
        hasLoopBodyEmptyWarning ||
        (result.steps.some((s) => s.kind === "loop" && s.status === "succeeded") &&
          Array.isArray(result.output) &&
          (result.output as unknown[]).length === 0);
      // Partial-success: the run finished but signals that the LLM
      // should look at the warnings before treating the output as
      // final. `transform_dropped_fields` is informational (intentional
      // projections legitimately narrow fields) and therefore does NOT
      // tip the run into partial_success on its own — surfacing the
      // warning is enough; blocking the commit gate would force the
      // LLM into the patch loop the skill explicitly forbids.
      const isPartialSuccess =
        result.status === "succeeded" &&
        (hasUnresolvedIdentifierWarning ||
          loopStepRanWithEmptyBody ||
          hasTransformEmptyExtractionWarning ||
          hasLoopOverUnresolvedWarning);
      const payloadStatus = isPartialSuccess ? "partial_success" : result.status;
      // requires_repair gates the auto-persist commit. Mirrors the
      // skill: only the warnings that ALWAYS indicate a real bug
      // (unresolved identifier, empty extraction, loop body never ran)
      // tip the flag. transform_dropped_fields is omitted on purpose —
      // the warning still fires, but commit is not blocked.
      const requiresRepair =
        hasUnresolvedIdentifierWarning ||
        hasTransformEmptyExtractionWarning ||
        hasLoopOverUnresolvedWarning ||
        isPartialSuccess;
      const diagnosisAvailable = hasWarnings || result.status !== "succeeded" || isPartialSuccess;
      // Per-step trace — same envelope shape dry_run_workflow returns
      // so the LLM can pinpoint the failing step + see its driver
      // metadata (status code, byte counts, connector resolution) in
      // one read. Always populated when the run
      // didn't succeed cleanly; omitted on success to save tokens
      // (the user can still inspect_workflow if they want details).
      const stepTraceEntries = result.steps.map((s) => {
        const errorCode =
          s.error && typeof s.error === "object" && s.error !== null
            ? (s.error as { code?: unknown }).code
            : undefined;
        const scope =
          s.output_preview !== undefined && s.output_preview !== null
            ? buildScopeAtStep(s.output_preview)
            : null;
        // Per-step LLM-context cap. The persisted step row (consumed
        // by inspect_execution_step / diagnose_latest_execution) keeps
        // the full preview; only the LLM-facing envelope is clipped,
        // because the offload threshold (10 KB) is bigger than the
        // outer LLM cap (8 KB) and a single inline preview can otherwise
        // dominate the envelope and force the outer truncate pass to
        // replace the workflow's `output` field with a marker.
        const previewForLlm =
          s.output_preview !== undefined && s.output_preview !== null
            ? truncateStepPreviewForLlm(s.output_preview)
            : null;
        const rawForLlm =
          s.raw_preview !== undefined && s.raw_preview !== null
            ? truncateStepPreviewForLlm(s.raw_preview)
            : null;
        return {
          step_id: s.step_key,
          kind: s.kind,
          status: s.status,
          ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
          ...(s.request_meta !== undefined && s.request_meta !== null
            ? { request_meta: s.request_meta }
            : {}),
          ...(previewForLlm
            ? {
                output_preview: previewForLlm.data,
                ...(previewForLlm.raw_ref ? { output_preview_ref: previewForLlm.raw_ref } : {}),
              }
            : {}),
          ...(rawForLlm
            ? {
                raw_preview: rawForLlm.data,
                ...(rawForLlm.raw_ref ? { raw_preview_ref: rawForLlm.raw_ref } : {}),
              }
            : {}),
          ...(scope ? { scope_at_step: scope } : {}),
          ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
          ...(s.error ? { error: s.error } : {}),
        };
      });
      const includeStepTrace =
        args.include_step_trace === true ||
        result.status !== "succeeded" ||
        isPartialSuccess ||
        hasWarnings;
      // Persist a compact per-step preview slot so subsequent
      // inspect_workflow / suggest_jsonata_paths / context-assembler
      // calls see the most recent shape per step. Mirrors what
      // dry_run_workflow does — the LLM reads from a single canonical
      // location regardless of whether the last walk was a dry-run
      // or a full run.
      const persistedStepTracesUnstamped = result.steps.map((s) => {
        const errorCode =
          s.error && typeof s.error === "object" && s.error !== null
            ? (s.error as { code?: unknown }).code
            : undefined;
        const scope =
          s.output_preview !== undefined && s.output_preview !== null
            ? buildScopeAtStep(s.output_preview)
            : undefined;
        return {
          step_id: s.step_key,
          kind: s.kind,
          status: s.status,
          ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
          ...(s.output_preview !== undefined && s.output_preview !== null
            ? { output_preview: s.output_preview }
            : {}),
          ...(s.raw_preview !== undefined && s.raw_preview !== null
            ? { raw_preview: s.raw_preview }
            : {}),
          ...(scope ? { scope_at_step: scope } : {}),
          ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
        };
      });
      // Fingerprint stamping: bind each trace to the step
      // definition it was recorded against so draft mutations drop
      // evidence per changed step, not wholesale.
      const persistedStepTraces = stampStepTraceFingerprints(
        persistedStepTracesUnstamped,
        (((wf.definition as WorkflowDef | null)?.steps ?? []) as unknown[]).filter(
          (s): s is Record<string, unknown> => typeof s === "object" && s !== null,
        ),
      );
      const previewedDraft = withLatestPreview(
        currentDraft,
        {
          ok: result.status === "succeeded",
          step_id:
            result.steps.find((s) => s.status !== "succeeded")?.step_key ??
            result.steps[result.steps.length - 1]?.step_key ??
            "(end)",
          summary: `run_workflow finished with status ${result.status}`,
          ...(hasWarnings && result.warnings ? { warnings: result.warnings } : {}),
          ...(requiresRepair ? { requires_repair: true } : {}),
          step_traces: persistedStepTraces,
          input: suppliedInput ?? null,
        },
        "run_workflow",
        "workflow_executed",
      );
      // Propagate the per-step scope vocabulary to the persisted
      // workflow_versions row. The commit path writes scope_index at
      // commit time, but a successful production run reveals new
      // shapes (especially after schema drift) — refreshing the
      // persisted vocabulary on every successful run keeps
      // suggest_jsonata_paths and inspect_workflow accurate without
      // requiring a re-commit. Only writes on full success to avoid
      // poisoning the persisted shape with partial / aborted runs.
      if (result.status === "succeeded" && !isPartialSuccess && wf.current_version_id) {
        const persistedScopeIndex: Record<
          string,
          { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
        > = {};
        for (const trace of persistedStepTraces) {
          if (trace.scope_at_step) {
            persistedScopeIndex[trace.step_id] = {
              available_paths: trace.scope_at_step.available_paths,
              shape_summary: trace.scope_at_step.shape_summary,
              primary_data_path: trace.scope_at_step.primary_data_path ?? null,
            };
          }
        }
        if (Object.keys(persistedScopeIndex).length > 0) {
          try {
            await ctx.db
              .update(workflowVersions)
              .set({ scope_index: persistedScopeIndex })
              .where(
                and(
                  eq(workflowVersions.tenant_id, ctx.tenant_id),
                  eq(workflowVersions.id, wf.current_version_id),
                ),
              );
          } catch (err) {
            logger.warn({
              module: "conversation_tool",
              action: "run_workflow.scope_index_persist_failed",
              tenant_id: ctx.tenant_id,
              workflow_id: workflowId,
              workflow_version_id: wf.current_version_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      const boundDraft = bindPersistedWorkflow(previewedDraft, {
        kind: "workflow",
        id: workflowId,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.current_version_id,
        version: wf.current_version,
        environment: null,
        saved_at: wf.updated_at.toISOString(),
      });
      const nextDraft = withWorkflowExecution(boundDraft, {
        execution_id: result.execution_id,
        workflow_id: workflowId,
        workflow_version_id: wf.current_version_id,
        status: payloadStatus,
        environment: args.environment,
        warnings_count: result.warnings?.length ?? 0,
        recorded_at: new Date().toISOString(),
        diagnosis_available: diagnosisAvailable,
        ...(requiresRepair ? { requires_repair: true } : {}),
      });
      await ctx.setDraft(nextDraft);
      // G9: surface the first failing step's key + message at the
      // envelope top level so the LLM can react in the same turn
      // instead of issuing a follow-up inspect_execution. Pre-fix the
      // failed envelope carried only `error` (engine-level) + `output`;
      // the LLM had to scan `result.steps[]` to identify WHICH step
      // failed, and the transcript showed it just shrugging and
      // retrying with a different workflow_id (session ed20f48d).
      const firstFailedStep =
        payloadStatus === "failed"
          ? result.steps.find((s) => s.status === "failed" || s.status === "timed_out")
          : undefined;
      const failureStepKey = firstFailedStep?.step_key;
      const failureReason =
        firstFailedStep?.error &&
        typeof firstFailedStep.error === "object" &&
        firstFailedStep.error !== null
          ? typeof (firstFailedStep.error as { message?: unknown }).message === "string"
            ? ((firstFailedStep.error as { message: string }).message ?? null)
            : null
          : null;
      // Sample a large output BEFORE the outer LLM-budget truncate sees the
      // envelope. Pre-fix the outer pass nulled the heaviest branch — which
      // was always `output` — so a 95-row success surfaced to the user as
      // "no output". A sample keeps REAL leading rows in front of the model
      // (it can answer "show the top 5" directly) with the full payload one
      // get_raw_result call away.
      const sampledOutput = sampleWorkflowOutputForLlm(result.output);
      return {
        ok: result.status === "succeeded" && !isPartialSuccess,
        data: withStatus(
          buildLifecyclePayload(nextDraft, {
            execution_id: result.execution_id,
            workflow_id: workflowId,
            workflow_version_id: wf.current_version_id,
            workflow_version: wf.current_version,
            // make the held writes unmistakable to the agent so it
            // never reads a verification run as a real send (a live session
            // once mailed stale snapshots this way). State, then affordance —
            // never an instruction to approve. See held-preview.ts for the
            // same contract on the MCP `wf_<slug>` envelope: an operator
            // approves; the model at most relays a decision it was given.
            ...(heldStepIds.length > 0
              ? {
                  writes_held: true,
                  held_step_ids: heldStepIds,
                  writes_held_note: `${heldStepIds.length} write step(s) were resolved but NOT dispatched. Nothing was written or sent, so this run is safe for verification. A live run is the operator's decision, not yours: only if the user explicitly asks for one, re-issue run_workflow with execute_writes:true — that call does NOT perform the writes either, it puts the approval in front of the operator, and the engine performs them itself once they answer. Never set execute_writes on your own initiative, and never approve on the user's behalf.`,
                }
              : {}),
            ...(failureStepKey ? { failure_step_key: failureStepKey } : {}),
            ...(failureReason ? { failure_reason: failureReason } : {}),
            // G1: tell the LLM the run accepted no inputs so the next
            // assistant turn does not pretend the parameter was honoured.
            ...(inputIgnored
              ? {
                  input_ignored: true,
                  input_ignored_note: `workflow "${wf.slug}" does not declare an input_schema; the supplied input was discarded. Tell the user the workflow accepts no inputs (or edit the workflow to bind one).`,
                }
              : {}),
            status: payloadStatus,
            output: sampledOutput.value,
            ...(sampledOutput.sampled
              ? {
                  output_sampled: true,
                  output_note: `output is a sample (in-band "… sampled N of M" markers mark the cut points); full payload via get_raw_result(ref="${sampledOutput.raw_ref}") or inspect_execution_step. Present the sampled rows to the user directly — do NOT re-run the workflow to "get" the output.`,
                  ...(sampledOutput.raw_ref ? { output_raw_ref: sampledOutput.raw_ref } : {}),
                }
              : {}),
            error: result.error,
            diagnosis_available: diagnosisAvailable,
            requires_repair: requiresRepair,
            recommended_next_tool: diagnosisAvailable ? "diagnose_latest_execution" : null,
            // Plain-language summary + structured next-action hint.
            // The transcript captured the symptom: "Execution needs
            // diagnosis · 1 warning" with no inline explanation, so
            // the user had to drop out of chat to dig in. Surface a
            // single sentence the chat renderer (and the never-silent
            // guard) can read directly.
            ...(diagnosisAvailable && result.warnings && result.warnings.length > 0
              ? {
                  warning_summary: `${result.warnings.length} warning(s): ${Array.from(
                    new Set(result.warnings.map((w) => w.code)),
                  )
                    .sort()
                    .join(", ")}. Run \`diagnose_latest_execution\` for details.`,
                }
              : {}),
            next_best_actions: diagnosisAvailable
              ? ["diagnose_latest_execution"]
              : result.status === "succeeded"
                ? ["inspect_execution_step", "run_workflow"]
                : ["diagnose_latest_execution", "inspect_workflow"],
            next_prompt: diagnosisAvailable
              ? "Open diagnosis to see what happened"
              : result.status === "succeeded"
                ? "Inspect step output or run again"
                : "Diagnose the failure",
            // Banner-style warnings summary so the LLM can't miss
            // signals on first read of the result envelope. Mirrors
            // the dry_run_workflow surface.
            ...(hasWarnings && result.warnings
              ? {
                  warnings_banner: {
                    count: result.warnings.length,
                    codes: Array.from(new Set(result.warnings.map((w) => w.code))).sort(),
                    summary: `${result.warnings.length} warning(s): ${Array.from(
                      new Set(result.warnings.map((w) => w.code)),
                    )
                      .sort()
                      .join(", ")}`,
                    entries: result.warnings,
                  },
                }
              : {}),
            ...(hasWarnings ? { warnings: result.warnings } : {}),
            ...(includeStepTrace ? { step_trace: stepTraceEntries } : {}),
            // D6 — optional RAW per-step inputs/outputs for self-diagnosis.
            // Compact by default; attached only when the caller opts in.
            ...(args.include_step_results
              ? { step_results: buildRawStepResults(result.steps) }
              : {}),
            // Teach the keystroke route: every successful chat run carries
            // the slash-equivalent the REPL chip strip will offer the user.
            suggested_command: `/workflows run ${wf.slug}`,
          }),
          // payloadStatus is one of the three terminal values (already
          // narrowed above), but withStatus is a no-op when the inner
          // payload already carries status — keep the default just in
          // case a future refactor drops the inline status.
          "failed",
        ),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.engineClient.audit_write({
        resource_type: "workflow",
        resource_id: workflowId,
        action: "conversation.run_workflow",
        result: "error",
        reason: msg,
        metadata: { conversation_id: ctx.conversation_id },
      });
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "run_failed",
            message: msg,
            recommended_mode: "execution",
          }),
          "failed",
        ),
      };
    }
  },
};
