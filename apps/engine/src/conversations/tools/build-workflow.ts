// `build_workflow` — one-shot authoring tool.
//
// Writes the entire draft in a single call: name, slug, description,
// steps, input_schema, output_transform, output_schema. The LLM is
// expected to use this when it already knows the full plan (e.g. after
// a discovery run or after a couple of `probe_connector` calls).
//
// Guards applied before the draft is accepted:
//
//   1. Schema shape — WorkflowDef zod validator from workflows/types.
//   2. Reference integrity on placeholders — every `${cred.<slug>.<field>}`
//      and `${connector.<slug>.*}` must point at a connector that exists
//      in the conversation's environment, and credential tokens must
//      match fields present on the decrypted credential.
//   3. Optional sample → schema inference for the input_schema.
//
// On any guard failure the draft is NOT persisted; the tool returns a
// WriteResult with code + details so the LLM can correct and retry in
// the next turn.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import {
  connectors as connectorsTable,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { describeConnectorPlaceholders, parsePlaceholders } from "../../llm/substitution/index.ts";
import { recordAuthoringGateBlock } from "../../observability/instrumentation.ts";
import { buildStepDag, detectCycles, renderCycleReport } from "../../workflows/dag.ts";
import { detectReservedAuthHeaders } from "../../workflows/header-policy.ts";
import {
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import { sampleToSchema } from "../../workflows/sample-to-schema.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { runCriticAgent } from "../authoring-critic/critic-agent.ts";
import { shouldRunCritic } from "../authoring-critic/gating.ts";
import type { AuthoringCriticVerdict, CriticRejectedDetails } from "../authoring-critic/types.ts";
import { withWorkflowDraft } from "../authoring-state.ts";
import { canonicalJson } from "../text-line-diff.ts";
import type { DraftDocument, WorkflowDraftDocument } from "../types.ts";
import { verifyWorkflow } from "../verifier.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { evaluateLoopAuthoringGate } from "./loop-authoring-gate.ts";
import { collectProbedConnectorSlugs } from "./probed-connectors.ts";
import { evaluateTransformAuthoringGate } from "./transform-authoring-gate.ts";

const StepShape = z.record(z.string(), z.unknown());

const BuildWorkflowInput = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u, "slug must match /^[a-z][a-z0-9_-]{0,63}$/"),
    description: z.string().max(2000).optional(),
    steps: z.array(StepShape).min(1).max(200),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    /** Sample input payload; the tool infers `input_schema` from it if
     *  `input_schema` is not provided. */
    input_schema_sample: z.unknown().optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    output_transform: z.string().optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
  })
  .openapi("BuildWorkflowToolInput");

interface PlaceholderProblem {
  token: string;
  code: "placeholder_connector_missing" | "placeholder_cred_missing";
  detail: string;
}

/** Walk an arbitrary value and return every string leaf. Used to scan
 *  step configs + transform expressions for placeholder tokens. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
    return out;
  }
  return out;
}

function buildWorkflowErrorPayload(gateError: ReturnType<typeof buildGateError>) {
  const { error: legacyError, ...rest } = gateError;
  return {
    ...rest,
    error: {
      code: rest.error_code,
      message: rest.message,
      details: {
        error: legacyError,
        ...rest,
      },
    },
  };
}

function buildWorkflowSuccessPayload(
  draft: DraftDocument,
  args: {
    name: string;
    slug: string;
    steps: Array<Record<string, unknown>>;
    input_schema_inferred: boolean;
    warnings: string[];
    infos: string[];
  },
) {
  const workflowSummary = {
    slug: args.slug,
    name: args.name,
    step_count: args.steps.length,
    input_schema_inferred: args.input_schema_inferred,
  };
  const lastStep = args.steps.at(-1);
  return {
    ...buildDraftMutationPayload(draft, {
      resource_kind: "workflow",
      extra: {
        name: args.name,
        workflow: workflowSummary,
        steps: args.steps.length,
        last_step_id: typeof lastStep?.id === "string" ? lastStep.id : null,
        step_type: typeof lastStep?.kind === "string" ? lastStep.kind : null,
        // build_workflow never auto-saves — the result is always a
        // draft. Surfacing the persistence state explicitly mirrors
        // the reference impl's `build_tool` contract so the LLM
        // never assumes the workflow is committed.
        persistence: "draft_only" as const,
        next_step: "save_workflow_draft" as const,
        warnings: args.warnings,
        infos: args.infos,
      },
    }),
    persistence: "draft_only" as const,
    draft: workflowSummary,
    warnings: args.warnings,
    infos: args.infos,
  };
}

export const buildWorkflowTool: ConversationTool = {
  name: "build_workflow",
  description:
    "Write an entire workflow draft in a single call. Validates the schema, checks placeholder references, and optionally infers input_schema from a sample.",
  use_case:
    "Use when you already know the full workflow structure — typically after probing connectors or after approving discovery artifacts. Saves 5–7 round-trips versus the incremental propose_step → connect_steps flow.",
  important_notes: [
    "Does NOT persist the workflow; it writes to the conversation draft. To save, surface a single `ask_user_confirm` with `commit_intent: { kind: 'save_workflow_draft', payload: { … }, description: 'Save this workflow.' }` — the harness atomically persists on confirm and injects a synthetic `save_workflow_draft` tool-result. Do NOT chain a separate `save_workflow_draft` call afterward.",
    String.raw`Every \${cred.<slug>.<field>} and \${connector.<slug>.*} must reference an existing connector + field in the target environment; mismatches yield placeholder_connector_missing / placeholder_cred_missing with exact token names.`,
    "If you pass `input_schema_sample` (a concrete payload) and omit `input_schema`, the tool infers a minimal JSON schema — accept the result or override explicitly.",
    "Replaces any in-progress draft on the conversation (idempotent): subsequent `build_workflow` calls overwrite the draft cleanly.",
  ],
  requires_skill: "workflow-authoring",
  example_input: {
    name: "Daily Stripe customers",
    slug: "stripe-daily-customers",
    steps: [
      {
        id: "fetch",
        kind: "request",
        connector_id: "00000000-0000-0000-0000-000000000000",
        method: "GET",
        path: "/v1/customers",
        headers: { Authorization: String.raw`Bearer \${cred.stripe.token}` },
      },
    ],
    environment: "dev",
  },
  inputSchema: BuildWorkflowInput,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const currentDraft = ctx.getDraft();
    const parsed = BuildWorkflowInput.safeParse(rawArgs);
    if (!parsed.success) {
      const gateError = buildGateError(currentDraft, {
        error_code: "invalid_input",
        message: "workflow build input failed schema validation",
        recommended_mode: "workflow",
        extra: {
          errors: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          })),
        },
      });
      return {
        ok: false,
        data: buildWorkflowErrorPayload(gateError),
      };
    }
    const args = parsed.data;

    // Schema shape + step discriminated union.
    const defValidation = WorkflowDefSchema.safeParse({
      name: args.name,
      slug: args.slug,
      ...(args.description ? { description: args.description } : {}),
      ...(args.input_schema ? { input_schema: args.input_schema } : {}),
      ...(args.output_schema ? { output_schema: args.output_schema } : {}),
      steps: args.steps,
    });
    if (!defValidation.success) {
      const gateError = buildGateError(currentDraft, {
        error_code: "workflow_schema_invalid",
        message: "workflow definition failed schema validation",
        recommended_mode: "workflow",
        extra: {
          errors: defValidation.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          })),
        },
      });
      return {
        ok: false,
        data: buildWorkflowErrorPayload(gateError),
      };
    }

    // Reserved auth headers — when a request step has `connector_id`,
    // the connector's saved credential injects auth at execution time.
    // An explicit `Authorization` / `Cookie` / `Proxy-Authorization`
    // header overrides that and the LLM routinely fills it with a
    // placeholder string that doesn't expand against the resolved
    // credential namespace. Skipped for connectors whose saved
    // `auth_type === "none"` — auth-flows.md documents the multi-step
    // token-mint pattern where step-level Authorization on a none-auth
    // connector_id step IS the entire point. Single source of truth in
    // `workflows/header-policy.ts`; the validator runs the same check
    // for mutation paths.
    const referencedConnectorIds = new Set<string>();
    for (const rawStep of args.steps) {
      const step = rawStep as Record<string, unknown>;
      if (step.kind === "request" && typeof step.connector_id === "string") {
        referencedConnectorIds.add(step.connector_id);
      }
    }
    const noneAuthConnectorIds = new Set<string>();
    if (referencedConnectorIds.size > 0) {
      const rows = await ctx.db
        .select({
          id: connectorsTable.id,
          auth_type: connectorsTable.auth_type,
        })
        .from(connectorsTable)
        .where(eq(connectorsTable.tenant_id, ctx.tenant_id));
      for (const row of rows) {
        if (referencedConnectorIds.has(row.id) && row.auth_type === "none") {
          noneAuthConnectorIds.add(row.id);
        }
      }
    }
    const reservedAuthHeaderViolations = detectReservedAuthHeaders(args.steps, {
      noneAuthConnectorIds,
    });

    // Placeholder reference-integrity. Scan every string leaf across
    // steps + output_transform for `${cred.*}` / `${connector.*}`.
    const stringLeaves = collectStrings(args.steps);
    if (args.output_transform) stringLeaves.push(args.output_transform);
    const tokensSeen = new Set<string>();
    const tokens: Array<{ kind: string; slug: string; field?: string; raw: string }> = [];
    for (const s of stringLeaves) {
      const { tokens: parsedTokens } = parsePlaceholders(s);
      for (const t of parsedTokens) {
        if (tokensSeen.has(t.raw)) continue;
        tokensSeen.add(t.raw);
        if (t.kind === "cred" && t.slug && t.field) {
          tokens.push({ kind: t.kind, slug: t.slug, field: t.field, raw: t.raw });
        } else if ((t.kind === "connector_url" || t.kind === "connector_config") && t.slug) {
          tokens.push({ kind: t.kind, slug: t.slug, raw: t.raw });
        }
      }
    }

    const problems: PlaceholderProblem[] = [];
    // Resolve every distinct connector slug once.
    const distinctSlugs = new Set(tokens.map((t) => t.slug));
    const slugToConnectorId = new Map<string, string | null>();
    const slugToPlaceholders = new Map<
      string,
      { credentials: string[]; url: string | null; config: string[] }
    >();
    for (const slug of distinctSlugs) {
      const rows = await ctx.db
        .select()
        .from(connectorsTable)
        .where(
          and(
            eq(connectorsTable.tenant_id, ctx.tenant_id),
            eq(connectorsTable.slug, slug),
            eq(connectorsTable.environment, args.environment),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        slugToConnectorId.set(slug, null);
        continue;
      }
      slugToConnectorId.set(slug, row.id);
      const descr = await describeConnectorPlaceholders(slug, {
        tenant_id: ctx.tenant_id,
        environment: args.environment,
        db: ctx.db,
      });
      slugToPlaceholders.set(slug, descr);
    }

    for (const tok of tokens) {
      if (slugToConnectorId.get(tok.slug) === null) {
        problems.push({
          token: tok.raw,
          code: "placeholder_connector_missing",
          detail: `connector slug '${tok.slug}' not found in ${args.environment}`,
        });
        continue;
      }
      if (tok.kind === "cred") {
        const descr = slugToPlaceholders.get(tok.slug);
        const credTokens = descr?.credentials ?? [];
        if (!credTokens.includes(tok.raw)) {
          problems.push({
            token: tok.raw,
            code: "placeholder_cred_missing",
            detail: `credential field '${tok.field ?? ""}' is not defined on connector '${tok.slug}'; known fields: ${credTokens.join(", ") || "(none configured)"}`,
          });
        }
      }
    }

    // Return reserved-auth-header errors and placeholder problems
    // together — operators fixing one then re-submitting only to see
    // the other was a known papercut (Pass F2). When both fire we
    // surface `reserved_auth_header_present` as the primary error_code
    // (it's the gate the LLM must clear first; placeholders cannot
    // resolve until the bogus Authorization header is removed) and
    // include the placeholder problems under `extra.placeholder_problems`.
    if (reservedAuthHeaderViolations.length > 0 || problems.length > 0) {
      if (reservedAuthHeaderViolations.length > 0) {
        recordAuthoringGateBlock({
          code: "reserved_auth_header_present",
          tool: "build_workflow",
        });
      }
      const primaryCode =
        reservedAuthHeaderViolations.length > 0
          ? "reserved_auth_header_present"
          : (problems[0]?.code ?? "placeholder_connector_missing");
      const messageParts: string[] = [];
      if (reservedAuthHeaderViolations.length > 0) {
        messageParts.push(
          `workflow steps with connector_id must not declare reserved auth headers: ${reservedAuthHeaderViolations.map((e) => e.path).join(", ")}`,
        );
      }
      if (problems.length > 0) {
        messageParts.push(
          "one or more placeholder references are unresolved against the current environment",
        );
      }
      const nextBestActions: string[] =
        reservedAuthHeaderViolations.length > 0
          ? ["update_param", "edit_workflow_patch"]
          : ["list_connectors", "get_connector"];
      const gateError = buildGateError(currentDraft, {
        error_code: primaryCode,
        message: messageParts.join("; "),
        recommended_mode: "workflow",
        next_best_actions: nextBestActions,
        extra: {
          // Match the legacy field names so existing LLM-side error
          // recovery + audit consumers don't have to learn a new
          // schema. Both `problems` (placeholder integrity) and
          // `errors` (reserved-auth-header) are surfaced; whichever
          // was empty is omitted.
          ...(reservedAuthHeaderViolations.length > 0
            ? {
                errors: reservedAuthHeaderViolations.map(({ path, message }) => ({
                  path,
                  message,
                })),
              }
            : {}),
          ...(problems.length > 0 ? { problems } : {}),
        },
      });
      return {
        ok: false,
        data: buildWorkflowErrorPayload(gateError),
      };
    }

    // Static verification: JSONata parse, scope-ref integrity, method
    // safety hints, output_schema sanity. Errors block the draft;
    // warnings + infos surface in the response so the author can decide
    // to ignore or fix.
    const verdict = verifyWorkflow({
      name: args.name,
      slug: args.slug,
      ...(args.description ? { description: args.description } : {}),
      steps: args.steps,
      ...(args.output_schema ? { output_schema: args.output_schema } : {}),
      ...(args.output_transform ? { output_transform: args.output_transform } : {}),
    });
    if (verdict.errors.length > 0) {
      const gateError = buildGateError(currentDraft, {
        error_code: "verifier_rejected",
        message: `static verifier found ${verdict.errors.length} error(s)`,
        recommended_mode: "workflow",
        extra: {
          errors: verdict.errors,
          warnings: verdict.warnings,
          infos: verdict.infos,
        },
      });
      return {
        ok: false,
        data: buildWorkflowErrorPayload(gateError),
      };
    }

    // Input schema inference.
    let input_schema = args.input_schema;
    const warnings: string[] = [];
    if (!input_schema && args.input_schema_sample !== undefined) {
      input_schema = sampleToSchema(args.input_schema_sample);
      warnings.push("input_schema_inferred_from_sample");
    }

    // Draft shape accepted by the conversation draft store.
    const workflowDraft: WorkflowDraftDocument = {
      name: args.name,
      slug: args.slug,
      steps: args.steps,
    };
    if (args.description) workflowDraft.description = args.description;
    if (input_schema) workflowDraft.input_schema = input_schema;
    if (args.output_schema) workflowDraft.output_schema = args.output_schema;
    if (args.output_transform) workflowDraft.output_transform = args.output_transform;

    // Cycle detection — pre-flight before the draft is accepted. A
    // workflow whose `${scope.X}` placeholders form a loop never
    // produces useful output (one of X always sees undefined). The
    // detector runs in pure-function mode against the assembled
    // WorkflowDef shape; cycles are typed as `workflow_cycle_detected`
    // so the LLM / operator can read the participating step ids.
    {
      // biome-ignore lint/suspicious/noExplicitAny: WorkflowDraftDocument is structurally compatible with WorkflowDef for DAG analysis
      const dag = buildStepDag(workflowDraft as any);
      const cycleReport = detectCycles(dag);
      if (cycleReport.has_cycle) {
        recordAuthoringGateBlock({ code: "workflow_cycle_detected", tool: "build_workflow" });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_cycle_detected",
            message: `workflow has a cyclic step dependency: ${renderCycleReport(cycleReport)}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
            extra: {
              cycles: cycleReport.cycles,
            },
          }),
        };
      }
    }

    // Unsupported placeholder rejection — Mustache `{{ ... }}`,
    // `${$loop...}`, `${user.X}`, etc. ship verbatim through to drivers
    // and produce 404s upstream. Reject with `did_you_mean` rewrites so
    // the LLM can fix on the next round-trip without burning a dry-run.
    {
      // biome-ignore lint/suspicious/noExplicitAny: WorkflowDraftDocument structurally compatible
      const placeholderErrors = validateUnsupportedPlaceholders(workflowDraft as any);
      if (placeholderErrors.length > 0) {
        const summary = placeholderErrors
          .map(
            (e) =>
              `step \`${e.step_id}\`.${e.field}: \`${e.raw}\` (${e.code}) → use \`${e.did_you_mean}\``,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "workflow_unsupported_placeholder",
          tool: "build_workflow",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_unsupported_placeholder",
            message: `workflow contains placeholder forms the runtime will not substitute: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
            extra: {
              unsupported_placeholders: placeholderErrors,
            },
          }),
        };
      }
    }

    // Reference validation — every `$scope.<id>...`, `$steps.<id>...`,
    // and `${scope.<id>...}` reference must point at a step that
    // actually exists in steps[]. Pre-fix the LLM could author
    // `over: "$scope.wrong_step.data"` and only see the typo at
    // runtime via `loop_over_unresolved`. Authoring-time refusal
    // saves a full dry-run cycle.
    {
      // biome-ignore lint/suspicious/noExplicitAny: WorkflowDraftDocument structurally compatible
      const refErrors = validateStepReferences(workflowDraft as any);
      if (refErrors.length > 0) {
        const summary = refErrors
          .map(
            (e) =>
              `step \`${e.step_id}\`.${e.field} references unknown step \`${e.bad_reference}\`` +
              (e.did_you_mean.length > 0
                ? ` (did you mean: ${e.did_you_mean.map((s) => `\`${s}\``).join(", ")})`
                : ""),
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "workflow_unresolved_step_reference",
          tool: "build_workflow",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_unresolved_step_reference",
            message: `workflow references unknown step ids: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
            extra: {
              unresolved_references: refErrors,
            },
          }),
        };
      }
    }

    // Loop-authoring inspection gate. Every loop step that reads
    // `$scope.<X>` must have a recorded preview for X with a
    // populated scope_at_step. Refuse when missing — the LLM should
    // dry-run first to learn the actual shape.
    //
    // Probe-evidence exemption: when X is a `request` step routed
    // through a connector the operator has already successfully
    // probed in this conversation, the probe counts as shape
    // evidence and the gate skips it. This matches the reference
    // impl's call_system → build_tool flow where probes ARE the
    // shape-discovery signal. Without this, the LLM had to add an
    // EXTRA dry_run_workflow round-trip after a successful probe
    // (session 0a01c5f3 16:18:26 wasted a turn on this).
    const probedConnectorSlugs = await collectProbedConnectorSlugs(ctx, workflowDraft.steps);
    {
      const gate = evaluateLoopAuthoringGate(workflowDraft, currentDraft.latest_preview ?? null, {
        probedConnectorSlugs,
      });
      if (!gate.ok) {
        const summary = gate.blocks
          .map(
            (b) =>
              `loop \`${b.loop_step_id}\` reads \`$scope.${b.referenced_step_id}\` but ${
                b.reason === "no_dry_run_yet"
                  ? "no dry-run has been recorded yet"
                  : b.reason === "no_preview_for_referenced_step"
                    ? `\`${b.referenced_step_id}\` has no recent preview`
                    : `the recorded preview for \`${b.referenced_step_id}\` doesn't include a scope summary`
              }`,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "loop_authoring_requires_inspect",
          tool: "build_workflow",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "loop_authoring_requires_inspect",
            message: `before committing a workflow with a loop step, dry-run once so the upstream step's actual output shape is recorded. ${summary}.`,
            recommended_mode: "workflow",
            next_best_actions: [
              "dry_run_workflow",
              "inspect_workflow_draft",
              "suggest_jsonata_paths",
            ],
            extra: {
              gate_blocks: gate.blocks,
            },
          }),
        };
      }
    }

    // Transform-authoring inspection gate — symmetric to the loop
    // variant. Refuses a `build_workflow` payload whose transform steps
    // cite `$scope.<X>...` for steps that have no recorded
    // `output_preview` yet. Pre-fix v4.8.0 this was wired only into
    // `propose_step` and `edit_workflow_patch`, so a one-shot
    // `build_workflow` could bypass the gate entirely.
    {
      const gate = evaluateTransformAuthoringGate(
        workflowDraft,
        currentDraft.latest_preview ?? null,
      );
      if (!gate.ok) {
        const summary = gate.blocks
          .map(
            (b) =>
              `transform \`${b.transform_step_id}\` reads \`$scope.${b.referenced_step_id}\` but ${
                b.reason === "no_dry_run_yet"
                  ? "no dry-run has been recorded yet"
                  : `\`${b.referenced_step_id}\` has no recent preview`
              }`,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "transform_authoring_requires_inspect",
          tool: "build_workflow",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "transform_authoring_requires_inspect",
            message: `before committing a workflow with a transform that reads upstream scope, dry-run once so the referenced step's actual output shape is recorded. ${summary}. Without a recorded shape the JSONata expression is a guess.`,
            recommended_mode: "workflow",
            next_best_actions: [
              "dry_run_workflow",
              "inspect_workflow_draft",
              "suggest_jsonata_paths",
            ],
            extra: {
              gate_blocks: gate.blocks,
            },
          }),
        };
      }
    }

    // Second-stage LLM critic. Gated by `llm.critic.*` config
    // (`enabled`, `min_steps`, `max_consecutive_rejections`).
    // Critic NEVER mutates the draft; a failed verdict becomes
    // `ok:false {error_code:"critic_rejected", repairs}` so the next
    // conversation turn picks the hints up via prior_failures.
    // Fail-open by design: provider errors / parse failures yield a
    // pass with an explanatory rationale rather than blocking the build.
    //
    // Drift signal: current draft's `latest_preview.warnings` plus
    // warnings from prior build_workflow calls on OTHER drafts in this
    // conversation (different slug). A re-author of a previously-drifted
    // workflow still triggers the critic via the prior-draft term;
    // re-authoring the SAME slug doesn't double-count because
    // `currentDraft.latest_preview` already reflects that draft's most
    // recent preview.
    //
    // Anti-loop: count consecutive `critic_rejected` outputs in the
    // recent tool-call window and skip the critic once
    // `max_consecutive_rejections` is reached, otherwise a stuck LLM
    // would burn tokens re-running the critic indefinitely.
    const recentBuildOutputs = await ctx.db
      .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, ctx.tenant_id),
          eq(conversationToolCalls.conversation_id, ctx.conversation_id),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(16);
    let consecutiveRejections = 0;
    for (const row of recentBuildOutputs) {
      if (row.tool !== "build_workflow") continue;
      const out = row.output as Record<string, unknown> | null;
      if (out && out.error_code === "critic_rejected") {
        consecutiveRejections += 1;
        continue;
      }
      break;
    }
    // Sum warnings from PRIOR build_workflow outputs on OTHER drafts
    // (different slug) only. A re-author of the current draft would
    // produce a row whose preview matches `currentDraft.latest_preview`;
    // counting both would double-count the same warning set. Filtering
    // by slug keeps the union-with-the-current-preview semantics
    // truthful: "did a different draft in this conversation also
    // drift" plus "did the current draft's preview drift".
    let priorDraftWarnings = 0;
    for (const row of recentBuildOutputs) {
      if (row.tool !== "build_workflow") continue;
      const out = row.output as Record<string, unknown> | null;
      if (!out) continue;
      const data = (out.data ?? {}) as Record<string, unknown>;
      const draftSummary = (data.draft ?? {}) as Record<string, unknown>;
      // Drop rows for the current slug — the current draft's warnings
      // are already counted via `currentDraft.latest_preview` below.
      if (typeof draftSummary.slug === "string" && draftSummary.slug === args.slug) continue;
      const previewWarnings = (data.preview ?? {}) as Record<string, unknown>;
      const warnings = previewWarnings.warnings;
      if (Array.isArray(warnings)) priorDraftWarnings += warnings.length;
    }
    const recentDriftCount =
      (currentDraft.latest_preview?.warnings?.length ?? 0) + priorDraftWarnings;
    const gating = shouldRunCritic({
      stepCount: workflowDraft.steps.length,
      recentDriftCount,
      consecutiveRejections,
      tenantId: ctx.tenant_id,
    });
    let criticVerdict: AuthoringCriticVerdict | undefined;
    if (gating.run) {
      criticVerdict = await runCriticAgent({
        draft: workflowDraft,
        tenant_id: ctx.tenant_id,
        db: ctx.db,
      });
      if (!criticVerdict.passed) {
        recordAuthoringGateBlock({ code: "critic_rejected", tool: "build_workflow" });
        const rejectedDetails: CriticRejectedDetails = {
          repairs: criticVerdict.repairs,
          rationale: criticVerdict.rationale,
          gating_reason: gating.reason,
        };
        return {
          ok: false,
          error_code: "critic_rejected",
          message: `LLM critic found ${criticVerdict.repairs.length} issue(s): ${criticVerdict.rationale}`,
          details: rejectedDetails,
          next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
        };
      }
    }

    // Pre-mutation snapshot for the inline diff cell (codex pattern):
    // emit a unified diff of the workflow DAG so the operator sees
    // exactly what changed structurally vs. the previous draft state.
    const beforeJson = canonicalJson(currentDraft.workflow ?? null);
    const nextDraft = withWorkflowDraft(currentDraft, workflowDraft, "workflow_built");
    await ctx.setDraft(nextDraft);
    // Detach from any previously-saved workflow target. build_workflow
    // replaces the draft wholesale; if the conversation row still
    // pointed at an earlier workflow with a different slug, downstream
    // save_workflow_draft would key the upsert on the stale id. The
    // commit-time identity gate also catches this, but resetting here
    // keeps inspect / dry_run pre-commit aligned with the new draft.
    if (currentDraft.workflow?.slug !== args.slug) {
      await ctx.db
        .update(conversations)
        .set({ target_workflow_id: null, updated_at: new Date() })
        .where(
          and(
            eq(conversations.tenant_id, ctx.tenant_id),
            eq(conversations.id, ctx.conversation_id),
          ),
        );
    }
    if (ctx.emitDiff) {
      const afterJson = canonicalJson(nextDraft.workflow ?? null);
      ctx.emitDiff({
        title: `workflow · ${args.slug}`,
        language: "json",
        before: beforeJson,
        after: afterJson,
      });
    }

    const infos = verdict.infos.map((info) => `${info.code}:${info.path}`);
    if (criticVerdict) {
      infos.push(`critic_passed:${gating.reason}`);
    }
    const warningCodes = [
      ...warnings,
      ...verdict.warnings.map((warning) => `${warning.code}:${warning.path}`),
    ];

    return {
      ok: true,
      data: buildWorkflowSuccessPayload(nextDraft, {
        name: args.name,
        slug: args.slug,
        steps: args.steps,
        input_schema_inferred: input_schema !== undefined && args.input_schema === undefined,
        warnings: warningCodes,
        infos,
      }),
    };
  },
};
