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

import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { connectors as connectorsTable } from "../db/schema/index.ts";
import { formatProbeShapeExamples } from "../llm/core/context-assembler/formatters.ts";
import { loadChunks, loadProbeShapeExamples } from "../llm/core/context-assembler/loaders.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import { TriggerSchema } from "../workflows/types.ts";
import { type ValidationError, validateWorkflowDef } from "../workflows/validator.ts";
import { withWorkflowDraft } from "./authoring-state.ts";
import { detectNamedOutputFormat } from "./output-format.ts";
import { type RecordedEvalReport, runRecordedEval } from "./recorded-eval.ts";
import type { ToolContext } from "./tools/index.ts";
import { getLastPreview } from "./tools/last-preview-store.ts";
import { collectProbedConnectorSlugs } from "./tools/probed-connectors.ts";
import type { WorkflowDraftDocument } from "./types.ts";

/** Hard cap on LLM generation passes: the initial generate plus at most
 *  one regenerate with the structural findings appended. Expression
 *  repairs do NOT count against this — they ride recorded-eval's own
 *  bounded (≤2 attempts per finding) repair stage. */
export const MAX_GENERATION_PASSES = 2;

/** Single wall-clock budget for the WHOLE pipeline — both generate
 *  passes plus recorded-eval's repair fan-out — expressed as one
 *  `AbortSignal.timeout`. Threaded as `signal` into every `invoke()` the
 *  pipeline and its repairs make (P1 gives each provider call its own
 *  90s ceiling; this is the aggregate ceiling so a serial chain of calls
 *  can't sum past it). On a deadline hit `invoke()` throws a typed
 *  `LlmProviderError`; the pipeline catches it and returns the best
 *  draft it has with the findings, never hangs. 120s leaves room for two
 *  generate passes plus a small bounded repair fan-out while staying
 *  well under the client socket budget the STALL exceeded. */
export const PIPELINE_DEADLINE_MS = 120_000;

/** Per-connector char budget for the ingested-docs excerpt embedded in
 *  the generation prompt. Mirrors the context assembler's discipline of
 *  bounding every section; tuning is a source change, not a knob. */
const DOCS_EXCERPT_CAP_CHARS = 1_500;
/** Max doc snippets folded into the excerpt per connector. */
const DOCS_SNIPPETS_PER_CONNECTOR = 4;
/** Char budget for the inlined `input_example` JSON. */
const INPUT_EXAMPLE_CAP_CHARS = 1_000;

/**
 * The authorable subset of `WorkflowDefSchema` the generate flow is
 * constrained to. Steps stay loose records — the full discriminated
 * union is enforced by `validateWorkflowDef` in the EVALUATE stage,
 * whose errors feed the single regenerate pass; a loose generation
 * schema keeps the provider's structured-output contract satisfiable.
 */
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
  output_transform: z.string().optional(),
  trigger: TriggerSchema.optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1).max(25),
});

export type GeneratedWorkflow = z.infer<typeof GeneratedWorkflowSchema>;

export interface AuthoringPipelineParams {
  ctx: ToolContext;
  /** The user's goal VERBATIM — quoted into the prompt and stashed on
   *  the draft for the preview judge. */
  goal: string;
  /** Connector ids OR slugs (mixed accepted) this workflow will call.
   *  Resolved tenant-scoped; unknown entries are reported, not
   *  silently dropped. */
  connector_ids?: string[];
  /** Concrete example of the workflow input, when the caller has one. */
  input_example?: unknown;
}

export type AuthoringPipelineResult =
  | {
      ok: true;
      definition: GeneratedWorkflow;
      validation: { ok: boolean; errors: ValidationError[] };
      recorded_eval: RecordedEvalReport;
      /** LLM generation passes actually spent (1 or 2). */
      attempts: number;
      /** Connector slugs/ids the caller named that did not resolve. */
      unresolved_connectors: string[];
      /** Set when the shared pipeline deadline (or turn abort) fired
       *  mid-generation: the draft below is the best one produced so
       *  far and the model should refine it from `recorded_eval`'s
       *  findings rather than expecting a clean artifact. */
      note?: string;
      next: "dry_run_workflow";
    }
  | {
      ok: false;
      error_code: "authoring_generation_failed" | "authoring_connectors_unresolved";
      message: string;
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
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the caller-named connectors (ids or slugs, mixed) to tenant
 *  rows. Tenant isolation lives in the query predicate. */
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
  }));
  const seen = new Set<string>();
  for (const r of resolved) {
    seen.add(r.id);
    seen.add(r.slug);
  }
  const unresolved = refs.filter((r) => !seen.has(r));
  return { resolved, unresolved };
}

/** Bounded ingested-docs excerpt per connector — same loader the
 *  context assembler uses (`loadChunks`, top-ranked snippets), bounded
 *  to a fixed char budget so grounding never blows the prompt. */
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

/**
 * The ONE generation prompt. Quotes the goal verbatim, grounds the
 * model in the resolved connectors + recorded endpoint samples + docs,
 * and states the authoring contracts: the verified JS function-body
 * contract (JS-first transforms), the flattened step shapes with the
 * `$item`-only loop addressing, the string-placeholder grammar, the
 * bulk-endpoint design rule, and the output_schema / trigger guidance.
 */
export function buildGenerationPrompt(args: {
  goal: string;
  connectors: GroundedConnector[];
  docsByConnector: Map<string, string[]>;
  samplesSection: string | null;
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

/**
 * Run the one-shot authoring pipeline. Never fires live HTTP; LLM cost
 * is bounded to `MAX_GENERATION_PASSES` generation calls plus
 * recorded-eval's own bounded repair. On success (including a
 * findings-laden definition) the draft IS stashed; only when no
 * schema-parseable definition materialised at all does the pipeline
 * return `authoring_generation_failed` with nothing stashed.
 */
export async function runAuthoringPipeline(
  params: AuthoringPipelineParams,
): Promise<AuthoringPipelineResult> {
  const { ctx, goal } = params;

  // -------------------------------------------------------------- GROUND
  const { resolved: connectors, unresolved } = await resolveConnectors(
    ctx,
    params.connector_ids ?? [],
  );
  // Fail fast when the caller named connectors and NONE resolved —
  // generating against zero grounding when grounding was requested
  // produces exactly the guessed-shape drafts this pipeline exists to
  // eliminate. Partial resolution proceeds and reports the misses.
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
  // GROUND fetches are independent reads — the probe-shape examples and
  // every per-connector docs excerpt run concurrently rather than one
  // connector at a time (a 5-connector goal paid 5× the slowest docs
  // search serially). Order is reconstructed deterministically below, so
  // the generation prompt is byte-identical to the sequential version.
  const [samples, docExcerpts] = await Promise.all([
    loadProbeShapeExamples(
      ctx.tenant_id,
      connectors.map((c) => c.id),
      ctx.db,
    ),
    Promise.all(
      connectors.map(async (c) => ({ id: c.id, excerpt: await loadDocsExcerpt(ctx, goal, c) })),
    ),
  ]);
  const samplesSection = formatProbeShapeExamples(samples);
  const docsByConnector = new Map<string, string[]>();
  for (const { id, excerpt } of docExcerpts) {
    if (excerpt.length > 0) docsByConnector.set(id, excerpt);
  }

  // ---------------------------------------------------- GENERATE/EVALUATE
  // One shared deadline for the whole pipeline (generate passes + the
  // recorded-eval repair fan-out). Merged with the turn's abort signal
  // when present so the stricter of (turn abort, pipeline deadline)
  // wins; threaded as `signal` into every nested `invoke()`. A hit
  // surfaces as a typed `LlmProviderError` out of `invoke()` (P1 maps
  // abort → provider error), which the loop below catches to degrade
  // gracefully instead of hanging.
  const deadlineSignal = ctx.abortSignal
    ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(PIPELINE_DEADLINE_MS)])
    : AbortSignal.timeout(PIPELINE_DEADLINE_MS);

  let definition: GeneratedWorkflow | null = null;
  let validationErrors: ValidationError[] = [];
  let attempts = 0;
  let priorFindings: string[] | null = null;
  /** Set when a generate pass aborted on the shared deadline / turn
   *  signal — the pipeline returns the best draft so far with a clear
   *  note instead of throwing or hanging. */
  let deadlineExceeded = false;

  // Output-format grounding signal: when the goal names a concrete output
  // format, the design rule in `buildGenerationPrompt` carries the
  // fidelity instruction into generation (the on-demand skill loader does
  // NOT inject the workflow-authoring skill in this single-shot path, so the
  // rule must live in always-present grounding). Logged once per run when a
  // format is named — greppable, and silent on plain-data goals.
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
    const prompt = buildGenerationPrompt({
      goal,
      connectors,
      docsByConnector,
      samplesSection,
      ...(params.input_example !== undefined ? { input_example: params.input_example } : {}),
      priorFindings,
    });
    attempts = pass;
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
      // Provider/quota failure: never throw out of the pipeline — the
      // tool surfaces a typed envelope the model can act on.
      const message = err instanceof Error ? err.message : String(err);
      // A deadline / turn-abort hit surfaces here as a typed provider
      // error (P1 maps abort → LlmProviderError). Stop the pipeline and
      // return what we have — do not burn the second pass re-hitting an
      // already-blown budget.
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
      // Strict validation — the one-shot artifact must be complete, so
      // forward-ref leniency does not apply.
      const validation = validateWorkflowDef(candidate);
      definition = candidate;
      validationErrors = validation.errors;
      passErrors = validation.errors;
      if (validation.ok) break;
    } else if (!definition) {
      // No definition materialised yet — surface this pass's errors.
      validationErrors = passErrors;
    }
    // Structural/validation failure → exactly one regenerate pass with
    // the findings appended; the loop bound enforces the hard cap.
    priorFindings = renderValidationFindings(passErrors);
  }

  if (!definition) {
    return {
      ok: false,
      error_code: "authoring_generation_failed",
      message:
        "the generation model produced no schema-parseable workflow definition within the pass cap",
      errors: validationErrors,
      attempts,
      unresolved_connectors: unresolved,
    };
  }

  // Recorded evaluation with the bounded repair stage armed — compile
  // + evaluation against recorded evidence only, zero egress. Findings
  // (and verified repair proposals) ride the result; the draft below is
  // stashed regardless so the model repairs from findings.
  const probedConnectorSlugs = await collectProbedConnectorSlugs(ctx, definition.steps);
  const currentDraft = ctx.getDraft();
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
    // Repair shares the pipeline deadline: an aborted repair `invoke()`
    // degrades to `{ repaired: false }` inside recorded-eval, so the
    // pipeline never hangs on the fan-out. If the deadline already fired
    // during generation, arm repair WITHOUT a signal-less budget — the
    // already-aborted signal makes every repair invoke fail fast, which
    // recorded-eval absorbs, leaving the findings intact for the model.
    { repair: { tenant_id: ctx.tenant_id, db: ctx.db, signal: deadlineSignal } },
  );
  // A deadline hit DURING the repair fan-out (not only during generation)
  // must also surface the time-budget note — else the
  // model gets findings with no signal that time ran out mid-repair.
  if (deadlineSignal.aborted) deadlineExceeded = true;

  // ----------------------------------------------------------------- EMIT
  // Stash as the conversation draft. Goal + connector ids ride the
  // draft as metadata (draft-only keys, same stash shape as
  // `build_workflow({ goal })`; the validator ignores them until commit
  // strips the draft down to its WorkflowDef shape). The goal feeds the
  // post-preview judge.
  const workflowDraft: WorkflowDraftDocument = {
    name: definition.name,
    slug: definition.slug,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.input_schema ? { input_schema: definition.input_schema } : {}),
    ...(definition.output_schema ? { output_schema: definition.output_schema } : {}),
    ...(definition.output_transform ? { output_transform: definition.output_transform } : {}),
    ...(definition.trigger ? { trigger: definition.trigger } : {}),
    steps: definition.steps,
  };
  const extra: Record<string, unknown> = {
    goal,
    connector_ids: connectors.map((c) => c.id),
  };
  const merged = { ...workflowDraft, ...extra } as WorkflowDraftDocument;
  const nextDraft = withWorkflowDraft(currentDraft, merged, "workflow_authored_one_shot");
  await ctx.setDraft(nextDraft);

  const findingCount = recordedEval.expressions.filter((f) => f.status !== "ok").length;
  const note = deadlineExceeded
    ? `generation/repair time budget exceeded — returning the current draft with ${findingCount} finding(s) for you to refine (edit_workflow_patch / update_param from recorded_eval.expressions)`
    : undefined;

  return {
    ok: true,
    definition,
    validation: { ok: validationErrors.length === 0, errors: validationErrors },
    recorded_eval: recordedEval,
    attempts,
    unresolved_connectors: unresolved,
    ...(note ? { note } : {}),
    next: "dry_run_workflow",
  };
}
