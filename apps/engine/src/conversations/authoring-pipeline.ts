// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens in the generation prompt are the placeholder grammar surfaced to the LLM.
// Engine-side one-shot authoring pipeline (Fix A).
//
// The authoring PROCESS moves into code: instead of the conversation
// model micro-iterating across ~30 tool calls (propose_step ×9,
// update_param ×9, dry_run ×9 — session 784c1b02), `author_workflow`
// runs this deterministic pipeline once and hands the model a complete,
// evaluated draft:
//
//   1. GROUND   — resolve the named connectors (tenant-scoped), load
//                 their recorded endpoint samples (`schema_versions`
//                 latest shapes) and a bounded slice of ingested docs,
//                 and build ONE generation prompt carrying the goal
//                 verbatim plus the authoring contracts.
//   2. GENERATE — ONE schema-constrained `invoke({flow:"generate"})`
//                 producing the complete definition (name, slug, steps
//                 with `language:"javascript"` transforms by default,
//                 input/output schema where derivable, trigger when the
//                 goal phrases cadence).
//   3. EVALUATE — `validateWorkflowDef` + `runRecordedEval` (with the
//                 bounded repair stage armed). Structural/validation
//                 failures earn exactly ONE regenerate pass with the
//                 findings appended; expression-level findings ride
//                 recorded-eval's own bounded repair instead. Hard cap:
//                 `MAX_GENERATION_PASSES` LLM generation passes total.
//   4. EMIT     — stash the result as the conversation draft
//                 (`withWorkflowDraft`, goal + connector ids stashed as
//                 draft-only metadata for the post-preview judge) and return
//                 `{ definition, recorded_eval, attempts, next:
//                 "dry_run_workflow" }`. Even a findings-laden
//                 definition is stashed — the model repairs from the
//                 findings via `edit_workflow_patch` / `update_param`.
//
// NO live HTTP fires anywhere in this pipeline. Grounding reads the DB,
// generation goes through `invoke()` (tenant token budget enforced like
// every other engine LLM call), and recorded evaluation runs JSONata /
// QuickJS against recorded evidence only. `dry_run_workflow` stays the
// explicit preview step.

import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { readDiscoveryIndexForConnector } from "../connectors/discovery/service.ts";
import type { DiscoveryResult } from "../connectors/discovery/types.ts";
import { connectors as connectorsTable, conversationToolCalls } from "../db/schema/index.ts";
import { LLM_CALL_TIMEOUT_MS } from "../llm/core/ai-sdk-model.ts";
import { formatProbeShapeExamples } from "../llm/core/context-assembler/formatters.ts";
import { loadChunks, loadProbeShapeExamples } from "../llm/core/context-assembler/loaders.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import { ResponseFilterSchema, TriggerSchema, WorkflowRuntimeSchema } from "../workflows/types.ts";
import { type ValidationError, validateWorkflowDef } from "../workflows/validator.ts";
import { runCriticAgent } from "./authoring-critic/critic-agent.ts";
import { shouldRunCritic } from "./authoring-critic/gating.ts";
import { withWorkflowDraft } from "./authoring-state.ts";
import {
  buildGroundingIndex,
  describeEndpointGroundingBlock,
  evaluateEndpointGrounding,
} from "./endpoint-grounding.ts";
import { groundingFingerprint } from "./intent-fingerprint.ts";
import { detectNamedOutputFormat } from "./output-format.ts";
import { type RecordedEvalReport, runRecordedEval } from "./recorded-eval.ts";
import type { ToolContext } from "./tools/index.ts";
import { getLastPreview } from "./tools/last-preview-store.ts";
import { collectProbedConnectorSlugs } from "./tools/probed-connectors.ts";
import type { WorkflowDraftDocument } from "./types.ts";

export const MAX_GENERATION_PASSES = 2;

export const PIPELINE_DEADLINE_MS = (MAX_GENERATION_PASSES + 1) * LLM_CALL_TIMEOUT_MS;

const DOCS_EXCERPT_CAP_CHARS = 1_500;
const DOCS_SNIPPETS_PER_CONNECTOR = 4;
const INPUT_EXAMPLE_CAP_CHARS = 1_000;
const DISCOVERED_ENDPOINTS_PER_CONNECTOR = 40;

function formatDiscoveredEndpoints(
  connectors: GroundedConnector[],
  discoveredById: Map<string, DiscoveryResult>,
): string | null {
  const blocks: string[] = [];
  for (const c of connectors) {
    const index = discoveredById.get(c.id);
    if (!index || index.endpoints.length === 0) continue;
    const lines = index.endpoints.slice(0, DISCOVERED_ENDPOINTS_PER_CONNECTOR).map((e) => {
      const ct = e.request_content_type ? ` [${e.request_content_type}]` : "";
      const summary = e.summary ? ` — ${e.summary}` : "";
      return `- ${e.method} ${e.path}${ct}${summary}`;
    });
    if (index.endpoints.length > DISCOVERED_ENDPOINTS_PER_CONNECTOR) {
      lines.push(
        `- …and ${index.endpoints.length - DISCOVERED_ENDPOINTS_PER_CONNECTOR} more (call discover_connector_endpoints for the full list).`,
      );
    }
    blocks.push(`### \`${c.slug}\` (base_url ${c.base_url ?? "(none)"})`, ...lines);
  }
  if (blocks.length === 0) return null;
  return [
    "## Discovered endpoints — authoritative source of truth",
    "The connector(s) below publish a machine-readable spec. These are the ONLY routes they expose. Bind every request step to one of these EXACT `method` + `path` pairs — do NOT invent, guess, drop a version prefix, or REST-ify routes (e.g. never turn `/v1/sites/{site}/content` into `/sites/{site}/items`). When an endpoint declares a request media type in `[brackets]`, encode the body that way — for `text/markdown` send the raw markdown string as the body, NOT a JSON object wrapping it.",
    ...blocks,
  ].join("\n");
}

export const GeneratedWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  description: z.string().max(2000).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  validation_expression: z.string().min(1).optional(),
  validation_function: z.string().min(1).optional(),
  output_transform: z.string().optional(),
  output_transform_function: z.string().min(1).optional(),
  response_filters: z.array(ResponseFilterSchema).optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_llm_tokens_per_run: z.number().int().positive().optional(),
  runtime: WorkflowRuntimeSchema.optional(),
  trigger: TriggerSchema.optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1).max(25),
});

export type GeneratedWorkflow = z.infer<typeof GeneratedWorkflowSchema>;

export interface AuthoringPipelineParams {
  ctx: ToolContext;
  goal: string;
  connector_ids?: string[];
  input_example?: unknown;
}

export interface CriticRejectionDetail {
  repairs: string[];
  rationale: string;
  gating_reason: string;
}

export type AuthoringPipelineResult =
  | {
      ok: true;
      definition: GeneratedWorkflow;
      validation: { ok: boolean; errors: ValidationError[] };
      recorded_eval: RecordedEvalReport;
      attempts: number;
      unresolved_connectors: string[];
      note?: string;
      critic_rejection?: CriticRejectionDetail;
      next: "dry_run_workflow";
    }
  | {
      ok: false;
      error_code:
        | "authoring_generation_failed"
        | "authoring_connectors_unresolved"
        | "authoring_definition_invalid";
      message: string;
      deadline_exceeded?: true;
      errors: ValidationError[];
      attempts: number;
      unresolved_connectors: string[];
    };

interface GroundedConnector {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  base_url: string | null;
  auth_type: string;
  description: string | null;
  self_description: { links?: { url?: string }[] } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveConnectors(
  ctx: ToolContext,
  refs: string[],
): Promise<{ resolved: GroundedConnector[]; unresolved: string[] }> {
  const ids = [...new Set(refs.filter((r) => UUID_RE.test(r)))];
  const slugs = [...new Set(refs.filter((r) => !UUID_RE.test(r)))];
  if (ids.length === 0 && slugs.length === 0) return { resolved: [], unresolved: [] };
  const idFilter = ids.length > 0 ? inArray(connectorsTable.id, ids) : null;
  const slugFilter = slugs.length > 0 ? inArray(connectorsTable.slug, slugs) : null;
  const refFilter =
    idFilter && slugFilter ? or(idFilter, slugFilter) : (idFilter ?? slugFilter ?? undefined);
  const rows = await ctx.db
    .select({
      id: connectorsTable.id,
      slug: connectorsTable.slug,
      display_name: connectorsTable.display_name,
      driver: connectorsTable.driver,
      base_url: connectorsTable.base_url,
      auth_type: connectorsTable.auth_type,
      config: connectorsTable.config,
      self_description: connectorsTable.self_description,
    })
    .from(connectorsTable)
    .where(and(eq(connectorsTable.tenant_id, ctx.tenant_id), refFilter));
  const resolved: GroundedConnector[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    driver: row.driver,
    base_url: row.base_url,
    auth_type: row.auth_type,
    description:
      typeof (row.config as Record<string, unknown> | null)?.description === "string"
        ? ((row.config as Record<string, unknown>).description as string)
        : null,
    self_description: (row.self_description as { links?: { url?: string }[] } | null) ?? null,
  }));
  const seen = new Set<string>();
  for (const r of resolved) {
    seen.add(r.id);
    seen.add(r.slug);
  }
  const unresolved = refs.filter((r) => !seen.has(r));
  return { resolved, unresolved };
}

async function loadDocsExcerpt(ctx: ToolContext, goal: string, c: GroundedConnector) {
  const chunks = await loadChunks(ctx.tenant_id, c.id, goal, ctx.db);
  const lines: string[] = [];
  let budget = DOCS_EXCERPT_CAP_CHARS;
  for (const chunk of chunks.slice(0, DOCS_SNIPPETS_PER_CONNECTOR)) {
    const head = chunk.title ?? chunk.path ?? "(doc)";
    const snippet = chunk.snippet.length > budget ? chunk.snippet.slice(0, budget) : chunk.snippet;
    lines.push(`- ${head}: ${snippet.replace(/\s+/g, " ").trim()}`);
    budget -= snippet.length;
    if (budget <= 0) break;
  }
  return lines;
}

export function buildGenerationPrompt(args: {
  goal: string;
  connectors: GroundedConnector[];
  docsByConnector: Map<string, string[]>;
  samplesSection: string | null;
  discoveredSection?: string | null;
  input_example?: unknown;
  priorFindings?: string[] | null;
}): string {
  const lines: string[] = [
    "Generate ONE complete sk workflow definition that satisfies the goal below. Return ONLY the structured object the schema demands — every step fully specified, no placeholders for 'fill in later'.",
    "",
    "## Goal (verbatim from the user)",
    args.goal,
  ];

  if (args.input_example !== undefined) {
    let rendered: string;
    try {
      rendered = JSON.stringify(args.input_example, null, 1) ?? "null";
    } catch {
      rendered = String(args.input_example);
    }
    if (rendered.length > INPUT_EXAMPLE_CAP_CHARS) {
      rendered = `${rendered.slice(0, INPUT_EXAMPLE_CAP_CHARS)}…`;
    }
    lines.push("", "## Workflow input example", "```json", rendered, "```");
  }

  if (args.connectors.length > 0) {
    lines.push("", "## Connectors available to this workflow");
    for (const c of args.connectors) {
      lines.push(
        `- \`${c.slug}\` (connector_id: ${c.id}) — driver ${c.driver}, base_url ${c.base_url ?? "(none)"}, auth ${c.auth_type}.` +
          (c.auth_type !== "none"
            ? " The engine injects the saved credential at execution time — request steps with `connector_id` must NOT declare an Authorization header."
            : "") +
          (c.description ? ` ${c.description}` : ""),
      );
      const docs = args.docsByConnector.get(c.id) ?? [];
      if (docs.length > 0) {
        lines.push(`  Docs excerpts for \`${c.slug}\`:`, ...docs.map((d) => `  ${d}`));
      }
    }
    lines.push(
      "",
      "Bind request steps to a connector via `connector_id` + relative `path` (the connector's base_url is prepended). Use the connector ids above verbatim.",
    );
  }

  if (args.discoveredSection) {
    lines.push("", args.discoveredSection);
  }

  if (args.samplesSection) {
    lines.push("", args.samplesSection);
  }

  lines.push(
    "",
    "## Step shape contract",
    "- `steps` is a flat array of `{ id, kind, … }`; kinds: `request`, `transform`, `call`, `wait`, `branch`, `parallel`, `loop`.",
    "- Request steps are FLATTENED: `connector_id`, `method`, `path` (or absolute `url`), `query`, `headers`, `body` live directly on the step — never inside a `config` wrapper.",
    '- Loop: `{ "id": "...", "kind": "loop", "over": "<JSONata over $scope.<step_id>.data…>", "body": ["<sibling_step_id>", …] }`. `body` is an ARRAY of sibling step ids (the body steps live in the same top-level `steps` array). `item_var` is retired — never emit it.',
    "- JSONata sites (`loop.over`, `branch.when`, `output_transform`): address upstream steps ONLY as `$scope.<step_id>.data…`, the workflow input as `$input`, the current loop item ONLY as `$item` (plus `$loop_index`). Bare item names are rejected. (Transforms are NOT JSONata — see the Transform contract below.)",
    "- String placeholders in request fields (`path` / `url` / `headers` / `query` / `body`): only `${input.<path>}`, `${scope.<step_id>.data.<path>}`, `${item.<path>}` (inside a loop body), `${cred.<slug>.<field>}`, `${connector.<slug>.url}`. Mustache `{{…}}` is rejected.",
    "",
    "## Transform contract — JavaScript only",
    'Every `transform` step is `language: "javascript"` (the default and only transform language). The execution contract (QuickJS sandbox, no host globals — no fetch, no process, no require, no network; values are JSON-marshalled):',
    "- The `expression` is a FUNCTION BODY (not a module, not an arrow function). It must `return` its result; a trailing expression also works.",
    "- It receives exactly one value, `input`:",
    "  - `input.scope.<step_id>.data` — recorded output of each upstream step",
    "  - `input.input` — the workflow input",
    "  - `input.scope.$item` / `input.scope.$loop_index` — inside a loop body",
    "JSONata is NOT a transform language — it survives only in `loop.over`, `branch.when`, `output_transform`, and `${…}` string interpolation.",
    "",
    "## Design rules",
    "- Prefer ONE bulk list endpoint over a nested per-item loop: when the vendor offers an endpoint that returns the collection with the fields you need, fetch it once and reshape with a single transform instead of looping a detail endpoint per item.",
    "- Every step output is uniformly enveloped as `{ data, … }` — downstream reads go through `.data`.",
    "- When the goal implies a concrete output shape, declare a minimal `output_schema` (JSON Schema: `type`/`properties`/`required` for exactly the fields the user asked for) — previews validate the real output against it, giving the loop a mechanical done-signal.",
    '- When the goal NAMES a concrete output FORMAT ("a markdown table", "CSV", "an HTML body", "a bulleted list"), the final `output_transform` (or the last transform feeding it) MUST RENDER that format as a STRING — correct data returned as a JSON array does NOT satisfy "return a markdown table". A markdown table needs a header row, a `| --- |` separator row, and one row per record; CSV needs a header line + comma-separated rows; a bulleted list needs `- ` per line.',
    '- When the goal phrases a recurring cadence ("daily at 9am", "täglich um 18 Uhr", "every 10 minutes"), bind `trigger: { "kind": "schedule", "cron": "<cron>", "tz": "<IANA tz>" }` as part of the definition.',
    "- `slug` is lowercase-hyphenated and derived from the name; step ids are short snake_case nouns.",
  );

  if (args.priorFindings && args.priorFindings.length > 0) {
    lines.push(
      "",
      "## Findings from the previous attempt (fix ALL of these)",
      ...args.priorFindings.map((f) => `- ${f}`),
    );
  }

  return lines.join("\n");
}

function renderValidationFindings(errors: ValidationError[]): string[] {
  return errors.map((e) => `${e.path}: ${e.message}`);
}

function toWorkflowDraftDocument(def: GeneratedWorkflow): WorkflowDraftDocument {
  return {
    name: def.name,
    slug: def.slug,
    ...(def.description ? { description: def.description } : {}),
    ...(def.input_schema ? { input_schema: def.input_schema } : {}),
    ...(def.output_schema ? { output_schema: def.output_schema } : {}),
    ...(def.validation_expression ? { validation_expression: def.validation_expression } : {}),
    ...(def.validation_function ? { validation_function: def.validation_function } : {}),
    ...(def.output_transform ? { output_transform: def.output_transform } : {}),
    ...(def.output_transform_function
      ? { output_transform_function: def.output_transform_function }
      : {}),
    ...(def.response_filters ? { response_filters: def.response_filters } : {}),
    ...(def.timeout_ms ? { timeout_ms: def.timeout_ms } : {}),
    ...(def.max_llm_tokens_per_run ? { max_llm_tokens_per_run: def.max_llm_tokens_per_run } : {}),
    ...(def.runtime ? { runtime: def.runtime } : {}),
    ...(def.trigger ? { trigger: def.trigger } : {}),
    steps: def.steps,
  };
}

async function countConsecutiveCriticRejections(ctx: ToolContext): Promise<number> {
  const rows = await ctx.db
    .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, ctx.tenant_id),
        eq(conversationToolCalls.conversation_id, ctx.conversation_id),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(8);
  let streak = 0;
  for (const row of rows) {
    if (row.tool !== "author_workflow") continue;
    const out = row.output as Record<string, unknown> | null;
    if (out && typeof out === "object" && out.critic_rejection !== undefined) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

export async function runAuthoringPipeline(
  params: AuthoringPipelineParams,
): Promise<AuthoringPipelineResult> {
  const { ctx, goal } = params;

  const { resolved: connectors, unresolved } = await resolveConnectors(
    ctx,
    params.connector_ids ?? [],
  );
  if ((params.connector_ids?.length ?? 0) > 0 && connectors.length === 0) {
    return {
      ok: false,
      error_code: "authoring_connectors_unresolved",
      message: `none of the named connectors resolved for this tenant: ${unresolved.join(", ")} — check list_connectors / find_connector for the actual ids and slugs`,
      errors: [],
      attempts: 0,
      unresolved_connectors: unresolved,
    };
  }
  ctx.onLog?.(
    "info",
    `ground · collecting recorded samples, docs and discovered endpoints for ${connectors.length} connector(s)`,
  );
  const [samples, docExcerpts, discoveredIndexes] = await Promise.all([
    loadProbeShapeExamples(
      ctx.tenant_id,
      connectors.map((c) => c.id),
      ctx.db,
    ),
    Promise.all(
      connectors.map(async (c) => ({ id: c.id, excerpt: await loadDocsExcerpt(ctx, goal, c) })),
    ),
    Promise.all(
      connectors.map(async (c) => ({
        id: c.id,
        index: await readDiscoveryIndexForConnector(ctx.db, ctx.tenant_id, {
          base_url: c.base_url,
          self_description: c.self_description,
        }),
      })),
    ),
  ]);
  const samplesSection = formatProbeShapeExamples(samples);
  const docsByConnector = new Map<string, string[]>();
  for (const { id, excerpt } of docExcerpts) {
    if (excerpt.length > 0) docsByConnector.set(id, excerpt);
  }
  const discoveredById = new Map<string, DiscoveryResult>();
  for (const { id, index } of discoveredIndexes) {
    if (index && index.endpoints.length > 0) discoveredById.set(id, index);
  }
  const discoveredSection = formatDiscoveredEndpoints(connectors, discoveredById);
  const discoveredEndpointCount = [...discoveredById.values()].reduce(
    (acc, index) => acc + index.endpoints.length,
    0,
  );
  ctx.onLog?.(
    "info",
    `ground · ${discoveredEndpointCount} discovered endpoint(s), docs for ${docsByConnector.size}/${connectors.length} connector(s)`,
  );
  const groundingIndex = buildGroundingIndex(connectors, discoveredById);

  const deadlineSignal = ctx.abortSignal
    ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(PIPELINE_DEADLINE_MS)])
    : AbortSignal.timeout(PIPELINE_DEADLINE_MS);
  const deadlineStartedAt = Date.now(); // allow-wall-clock
  const msRemaining = (): number =>
    Math.max(0, PIPELINE_DEADLINE_MS - (Date.now() - deadlineStartedAt)); // allow-wall-clock

  let definition: GeneratedWorkflow | null = null;
  let lastValid: { definition: GeneratedWorkflow; errors: ValidationError[] } | null = null;
  let validationErrors: ValidationError[] = [];
  let attempts = 0;
  let priorFindings: string[] | null = null;
  let deadlineExceeded = false;
  let criticRan = false;
  let criticRejection: CriticRejectionDetail | null = null;

  const runCriticGate = async (
    candidate: GeneratedWorkflow,
  ): Promise<{ rejection: CriticRejectionDetail; priorFindings: string[] } | null> => {
    const recentDriftCount = ctx.getDraft().latest_preview?.warnings?.length ?? 0;
    const consecutiveRejections = await countConsecutiveCriticRejections(ctx);
    const gate = shouldRunCritic({
      stepCount: candidate.steps.length,
      recentDriftCount,
      consecutiveRejections,
      tenantId: ctx.tenant_id,
    });
    if (!gate.run) return null;
    const verdict = await runCriticAgent({
      draft: toWorkflowDraftDocument(candidate),
      tenant_id: ctx.tenant_id,
      db: ctx.db,
      signal: deadlineSignal,
    });
    if (verdict.passed || verdict.repairs.length === 0) {
      return null;
    }
    logger.info({
      module: "conversations",
      action: "authoring_pipeline.critic_rejected",
      msg: "semantic critic rejected a static-clean draft — feeding repairs into one more grounded regenerate pass",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      gating_reason: gate.reason,
      repair_count: verdict.repairs.length,
    });
    return {
      rejection: {
        repairs: verdict.repairs,
        rationale: verdict.rationale,
        gating_reason: gate.reason,
      },
      priorFindings: renderValidationFindings(
        verdict.repairs.map((r) => ({ path: "critic", message: r })),
      ),
    };
  };

  const namedOutputFormat = detectNamedOutputFormat(goal);
  if (namedOutputFormat) {
    logger.info({
      module: "conversations",
      action: "authoring_pipeline.output_format_grounded",
      msg: "goal names a concrete output format — fidelity rule grounded into generation",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      named_format: namedOutputFormat,
    });
  }

  for (let pass = 1; pass <= MAX_GENERATION_PASSES; pass++) {
    if (deadlineSignal.aborted) {
      deadlineExceeded = true;
      break;
    }
    if (pass > 1 && msRemaining() < LLM_CALL_TIMEOUT_MS) {
      deadlineExceeded = true;
      logger.warn({
        module: "conversations",
        action: "authoring_pipeline.pass_skipped_no_budget",
        msg: "skipping a generate pass that cannot finish within the remaining pipeline budget",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        pass,
        ms_remaining: msRemaining(),
        ms_required: LLM_CALL_TIMEOUT_MS,
      });
      break;
    }
    const prompt = buildGenerationPrompt({
      goal,
      connectors,
      docsByConnector,
      samplesSection,
      discoveredSection,
      ...(params.input_example !== undefined ? { input_example: params.input_example } : {}),
      priorFindings,
    });
    attempts = pass;
    ctx.onLog?.(
      "info",
      pass === 1
        ? "generate · one schema-constrained generation pass"
        : `generate · regenerating with ${priorFindings?.length ?? 0} finding(s) from the previous pass (${pass}/${MAX_GENERATION_PASSES})`,
    );
    let candidate: GeneratedWorkflow | null = null;
    let passErrors: ValidationError[] = [];
    try {
      const result = await invoke(
        {
          flow: "generate",
          tenant_id: ctx.tenant_id,
          user_turns: [{ role: "user", content: prompt }],
          schema: GeneratedWorkflowSchema,
          signal: deadlineSignal,
        },
        ctx.db,
      );
      const parsed = GeneratedWorkflowSchema.safeParse(result.object);
      if (parsed.success) {
        candidate = parsed.data;
      } else {
        passErrors = parsed.error.issues.map((i) => ({
          path: i.path.map((p) => String(p)).join("."),
          message: typeof i.message === "string" ? i.message : JSON.stringify(i.message),
        }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (deadlineSignal.aborted) {
        deadlineExceeded = true;
        logger.warn({
          module: "conversations",
          action: "authoring_pipeline.deadline_exceeded",
          msg: "generation aborted on the shared pipeline deadline — returning the best draft so far",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          pass,
        });
        if (!definition) validationErrors = [{ path: "(llm)", message }];
        break;
      }
      logger.warn({
        module: "conversations",
        action: "authoring_pipeline.generate_failed",
        msg: "one-shot generation LLM call failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        pass,
        error: message,
      });
      passErrors = [{ path: "(llm)", message }];
    }

    if (candidate) {
      const validation = validateWorkflowDef(candidate);
      const grounding = evaluateEndpointGrounding(candidate.steps, groundingIndex);
      const groundingErrors: ValidationError[] = grounding.blocks.map((b) => ({
        path: `steps.${b.step_id}.${b.reason === "content_type_mismatch" ? "body" : "path"}`,
        message: describeEndpointGroundingBlock(b),
      }));
      if (groundingErrors.length > 0) {
        logger.info({
          module: "conversations",
          action: "authoring_pipeline.endpoint_grounding_block",
          msg: "generated draft targets undocumented connector path(s) — regenerating with the discovered routes",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          pass,
          block_count: groundingErrors.length,
          reasons: grounding.blocks.map((b) => b.reason),
        });
      }
      definition = candidate;
      validationErrors = [...validation.errors, ...groundingErrors];
      if (validation.ok) lastValid = { definition: candidate, errors: validationErrors };
      passErrors = validationErrors;
      ctx.onLog?.(
        validationErrors.length > 0 ? "warn" : "info",
        validationErrors.length > 0
          ? `generate · draft "${candidate.name}" (${candidate.steps.length} steps) — ${validationErrors.length} validation/grounding finding(s)`
          : `generate · draft "${candidate.name}" (${candidate.steps.length} steps) — static gates clean`,
      );
      if (validation.ok && grounding.ok) {
        if (!criticRan && !deadlineSignal.aborted) {
          criticRan = true;
          const critic = await runCriticGate(candidate);
          if (critic) {
            ctx.onLog?.(
              "warn",
              `critic · rejected the draft with ${critic.rejection.repairs.length} repair(s) — one more grounded regenerate pass`,
            );
            criticRejection = critic.rejection;
            priorFindings = critic.priorFindings;
            continue;
          }
        }
        break;
      }
    } else if (!definition) {
      validationErrors = passErrors;
    }
    priorFindings = renderValidationFindings(passErrors);
  }

  if (definition && lastValid && definition !== lastValid.definition) {
    definition = lastValid.definition;
    validationErrors = lastValid.errors;
  }

  if (!definition) {
    return {
      ok: false,
      error_code: "authoring_generation_failed",
      message: deadlineExceeded
        ? "generation ran out of time before producing a complete definition — the model was cut off, not wrong. Retry, or split the specification into smaller workflows."
        : "the generation model produced no schema-parseable workflow definition within the pass cap",
      ...(deadlineExceeded ? { deadline_exceeded: true } : {}),
      errors: validationErrors,
      attempts,
      unresolved_connectors: unresolved,
    };
  }

  const currentDraft = ctx.getDraft();
  const existingTrigger = currentDraft.workflow?.trigger;
  const editingSameSlug =
    existingTrigger !== undefined && currentDraft.workflow?.slug === definition.slug;
  if (definition.trigger === undefined && editingSameSlug) {
    logger.info({
      module: "conversations",
      action: "authoring_pipeline.trigger_preserved_on_edit",
      msg: "regenerated draft omitted a trigger while editing an existing workflow — preserving the saved trigger to protect its reverse-bound binding",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      slug: definition.slug,
      trigger_kind: existingTrigger?.kind ?? null,
    });
    definition.trigger = existingTrigger;
  }

  const workflowDraft = toWorkflowDraftDocument(definition);
  const structural = validateWorkflowDef(workflowDraft);
  if (!structural.ok) {
    logger.warn({
      module: "conversations",
      action: "authoring_pipeline.definition_invalid",
      msg: "generated definition fails workflow validation — refusing to stash it as the draft",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      attempts,
      error_count: structural.errors.length,
    });
    return {
      ok: false,
      error_code: "authoring_definition_invalid",
      message: `the generated definition is not a valid workflow after ${attempts} generation pass(es) (${structural.errors
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}). It was not stored as the draft; the previous draft is unchanged.`,
      ...(deadlineExceeded ? { deadline_exceeded: true } : {}),
      errors: structural.errors,
      attempts,
      unresolved_connectors: unresolved,
    };
  }

  ctx.onLog?.(
    "info",
    `evaluate · compiling and evaluating ${definition.steps.length} step(s) against recorded evidence (bounded repair armed)`,
  );
  const probedConnectorSlugs = await collectProbedConnectorSlugs(ctx, definition.steps);
  const lastPreview = getLastPreview({
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
  });
  const recordedEval = await runRecordedEval(
    {
      steps: definition.steps,
      ...(definition.output_transform !== undefined
        ? { output_transform: definition.output_transform }
        : {}),
    },
    {
      latest_preview: currentDraft.latest_preview ?? null,
      scope: lastPreview?.scope ?? null,
      input: lastPreview?.input ?? currentDraft.latest_preview?.input ?? null,
      probedConnectorSlugs,
    },
    { repair: { tenant_id: ctx.tenant_id, db: ctx.db, signal: deadlineSignal } },
  );
  if (deadlineSignal.aborted) deadlineExceeded = true;

  const extra: Record<string, unknown> = {
    goal,
    connector_ids: connectors.map((c) => c.id),
  };
  const merged = { ...workflowDraft, ...extra } as WorkflowDraftDocument;
  const nextDraft = withWorkflowDraft(currentDraft, merged, "workflow_authored_one_shot");
  const groundingFp = groundingFingerprint(groundingIndex);
  if (groundingFp && nextDraft.state) {
    nextDraft.state.grounding_fingerprint = groundingFp;
    nextDraft.state.grounding_connector_ids = connectors
      .filter((c) => (discoveredById.get(c.id)?.endpoints.length ?? 0) > 0)
      .map((c) => c.id);
  }
  await ctx.setDraft(nextDraft);

  const findingCount = recordedEval.expressions.filter((f) => f.status !== "ok").length;
  ctx.onLog?.(
    findingCount > 0 ? "warn" : "info",
    findingCount > 0
      ? `emit · draft stashed with ${findingCount} recorded-eval finding(s) — next: apply repairs, then dry_run_workflow`
      : "emit · draft stashed clean — next: dry_run_workflow",
  );
  const note = deadlineExceeded
    ? `generation/repair time budget exceeded — returning the current draft with ${findingCount} finding(s) for you to refine (edit_workflow_patch from recorded_eval.expressions)`
    : undefined;

  return {
    ok: true,
    definition,
    validation: { ok: validationErrors.length === 0, errors: validationErrors },
    recorded_eval: recordedEval,
    attempts,
    unresolved_connectors: unresolved,
    ...(note ? { note } : {}),
    ...(criticRejection ? { critic_rejection: criticRejection } : {}),
    next: "dry_run_workflow",
  };
}
