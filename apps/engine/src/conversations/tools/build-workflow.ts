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
import { and, eq } from "drizzle-orm";
import { connectors as connectorsTable, conversations } from "../../db/schema/index.ts";
import { describeConnectorPlaceholders, parsePlaceholders } from "../../llm/substitution/index.ts";
import { recordAuthoringGateBlock } from "../../observability/instrumentation.ts";
import { buildStepDag, detectCycles, renderCycleReport } from "../../workflows/dag.ts";
import {
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import { sampleToSchema } from "../../workflows/sample-to-schema.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { withWorkflowDraft } from "../authoring-state.ts";
import { canonicalJson } from "../text-line-diff.ts";
import type { DraftDocument, WorkflowDraftDocument } from "../types.ts";
import { verifyWorkflow } from "../verifier.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { evaluateLoopAuthoringGate } from "./loop-authoring-gate.ts";
import { collectProbedConnectorSlugs } from "./probed-connectors.ts";

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
    // credential namespace. Refuse at build time so the draft never
    // reaches preview in a state that will fail (conversation 730c568a).
    const reservedAuthHeaderErrors: Array<{ path: string; message: string }> = [];
    for (const rawStep of args.steps) {
      const step = rawStep as Record<string, unknown>;
      if (step.kind !== "request") continue;
      if (typeof step.connector_id !== "string") continue;
      const headers = step.headers;
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) continue;
      for (const headerName of Object.keys(headers as Record<string, unknown>)) {
        const lower = headerName.toLowerCase();
        if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization") {
          reservedAuthHeaderErrors.push({
            path: `steps.${typeof step.id === "string" ? step.id : "?"}.headers.${headerName}`,
            message: `do not set a ${headerName} header on a request step that has connector_id — the connector injects auth from its saved credential. Remove the header (the connector's auth_type drives Authorization automatically).`,
          });
        }
      }
    }
    if (reservedAuthHeaderErrors.length > 0) {
      recordAuthoringGateBlock({
        code: "reserved_auth_header_present",
        tool: "build_workflow",
      });
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "reserved_auth_header_present",
          message: `workflow steps with connector_id must not declare reserved auth headers: ${reservedAuthHeaderErrors.map((e) => e.path).join(", ")}`,
          recommended_mode: "workflow",
          next_best_actions: ["update_param", "edit_workflow_patch"],
          extra: {
            errors: reservedAuthHeaderErrors,
          },
        }),
      };
    }

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

    if (problems.length > 0) {
      const firstCode = problems[0]?.code ?? "placeholder_connector_missing";
      const gateError = buildGateError(currentDraft, {
        error_code: firstCode,
        message:
          "one or more placeholder references are unresolved against the current environment",
        recommended_mode: "workflow",
        next_best_actions: ["list_connectors", "get_connector"],
        extra: {
          problems,
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
