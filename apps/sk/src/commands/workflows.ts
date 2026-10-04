import { exitCodeFor, reportCommandError } from "@cli-core/errors";
import { emitGroupedList, emitList, printJson } from "@cli-core/format";
import {
  INVOKE_ENVIRONMENTS,
  INVOKE_SNIPPET_LANGUAGES,
  isInvokeEnvironment,
  isInvokeSnippetLanguage,
} from "@shared/invoke-snippet.ts";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  EngineClient,
  type RunExecutionBody,
  type RunExecutionResponse,
} from "../engine-client.ts";
import { effectiveTriggerLabel, type TriggerFields } from "../lib/effective-trigger.ts";
import {
  INVOCATION_LOOKUP_TIMEOUT_MS,
  type LocalSnippetReason,
  resolveInvokeSnippet,
} from "../lib/invoke-snippet-source.ts";
import { pickId } from "../lib/pick.ts";
import { exitCodeForTerminalStatus, tailExecution } from "../lib/tail-execution.ts";
import { computeStepBottlenecks, humanMs } from "../render/format.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type {
  PlanStep,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "../render/types.ts";
import { formatFileRef } from "../utils/file-ref.ts";
import { uploadPath } from "./files.ts";
import { WORKFLOW_LIST_COLUMNS } from "./list-columns.ts";

function parseTrigger(raw: unknown): WorkflowTrigger {
  if (raw && typeof raw === "object") {
    const t = raw as Record<string, unknown>;
    if (t.kind === "schedule") {
      return {
        kind: "schedule",
        cron: typeof t.cron === "string" ? t.cron : "?",
        tz: typeof t.tz === "string" ? t.tz : "UTC",
      };
    }
    if (t.kind === "webhook") {
      return {
        kind: "webhook",
        source: typeof t.source === "string" ? t.source : "?",
        events: Array.isArray(t.events) ? t.events.filter((e) => typeof e === "string") : [],
      };
    }
  }
  return { kind: "request" };
}

function intentFromBody(body: Record<string, unknown>): WorkflowIntent {
  // The file passed to create/update IS the WorkflowDef (steps/trigger at
  // top level). Pre-fix this read a never-present `body.definition`
  // nesting, so the intent always showed zero steps and trigger=request
  // regardless of the actual definition. Keep the nested shape as a
  // fallback for run --draft style envelopes.
  const definition =
    Array.isArray(body.steps) || body.trigger !== undefined
      ? body
      : ((body.definition as Record<string, unknown>) ?? {});
  const rawSteps = Array.isArray(definition.steps) ? definition.steps : [];
  const steps = rawSteps.map((s) => {
    const r = (s ?? {}) as Record<string, unknown>;
    return {
      key: typeof r.key === "string" ? r.key : typeof r.id === "string" ? r.id : "(step)",
      kind: typeof r.kind === "string" ? r.kind : "step",
    };
  });
  return {
    kind: "workflow",
    name: typeof body.name === "string" ? body.name : "(workflow)",
    ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
    trigger: parseTrigger(definition.trigger),
    steps,
  };
}

/** Print the workflow run JSON, then — when connector_resolutions or
 *  warnings are present — a compact summary to stderr so humans can
 *  eyeball which connector, auth method, and environment every step
 *  actually hit, and which steps surfaced warnings (unresolved
 *  identifiers, rate-limit hits, pagination edges). */
function printRunResult(result: RunExecutionResponse): void {
  printJson(result);
  if (result.idempotent_replay) {
    process.stderr.write(
      `\n${pc.dim("note:")} nothing new was started — an earlier run already used this idempotency key\n`,
    );
  }
  const warnings = (result.warnings ?? []) as Array<{
    step_key?: string;
    code?: string;
    message?: string;
  }>;
  if (warnings.length > 0) {
    process.stderr.write(`\n${pc.dim("warnings:")}\n`);
    for (const w of warnings) {
      const step = w.step_key ?? "(run)";
      const code = w.code ?? "unknown";
      const msg = w.message ?? "";
      process.stderr.write(`  ${pc.yellow("WARN")} step=${step} code=${code} msg=${msg}\n`);
    }
  }
  // Inline performance: surface the slowest step/connector call from the
  // run's steps payload (each carries `duration_ms`) so an operator sees
  // the bottleneck right after the run, without reaching for `sk stats`
  // or `sk executions get`. Reuses the same bottleneck computation the
  // execution detail uses.
  const ranked = computeStepBottlenecks(
    (result.steps ?? []) as unknown as Array<Record<string, unknown>>,
  );
  const slowest = ranked[0];
  if (slowest) {
    const conn = slowest.connector_slug ? ` ${pc.dim(`(${slowest.connector_slug})`)}` : "";
    process.stderr.write(
      `\n${pc.dim("slowest step:")} ${pc.cyan(slowest.step_key)} ` +
        `${humanMs(slowest.duration_ms)} (${slowest.pct.toFixed(0)}% of run)${conn}\n`,
    );
  }
  const rs = result.connector_resolutions ?? [];
  if (rs.length === 0) return;
  process.stderr.write(`\n${pc.dim("connector resolutions:")}\n`);
  for (const r of rs) {
    const env = `${r.requested_environment} → ${r.resolved_environment}`;
    process.stderr.write(
      `  ${pc.cyan(r.step_key)}  ${r.connector_slug} (${r.driver})  ${env}  ${pc.yellow(r.auth_method)}\n`,
    );
  }
}

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

/** Candidate rows for the interactive workflow picker (TTY only). */
const fetchWorkflowRows = async (client: EngineClient) => {
  const { items } = await client.listWorkflows({ limit: 50 });
  return (items as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: typeof r.name === "string" ? r.name : null,
    detail: typeof r.slug === "string" ? r.slug : null,
  }));
};

const WORKFLOW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve a `sk workflows run` positional that may be a workflow id OR a
 *  slug (or exact name). A UUID passes through untouched; otherwise we look
 *  it up against the tenant's workflows. The engine's saved-run route only
 *  accepts a UUID `workflow_id`, so resolving here turns the prior cryptic
 *  `bad_request: request validation failed` into either the correct run or a
 *  clear, actionable error. */
export async function resolveWorkflowIdOrSlug(
  client: EngineClient,
  idOrSlug: string,
): Promise<string> {
  if (WORKFLOW_UUID_RE.test(idOrSlug)) return idOrSlug;
  const { items } = await client.listWorkflows({ limit: 200 });
  const matches = (items as Record<string, unknown>[]).filter(
    (r) => r.slug === idOrSlug || r.name === idOrSlug,
  );
  if (matches.length === 1) return String(matches[0]?.id);
  if (matches.length > 1) {
    throw new Error(
      `workflow '${idOrSlug}' is ambiguous — matched ${matches.length} workflows; pass the workflow id (see 'sk workflows list')`,
    );
  }
  throw new Error(
    `no workflow found with id or slug '${idOrSlug}' — run 'sk workflows list' to see available workflows`,
  );
}

const LOCAL_SNIPPET_NOTES: Record<LocalSnippetReason, string> = {
  engine_unreachable: "The engine could not be reached.",
  workflow_unknown: "The engine does not know this workflow id.",
  no_public_address: "The engine has no public address configured (server.public_base_url).",
};

const invokeSnippetCommand = defineCommand({
  meta: {
    name: "invoke-snippet",
    description:
      "Emit a ready-to-paste, authenticated snippet to run a saved workflow from your own app or CI (curl/node/python).",
  },
  args: {
    id: { type: "positional", required: true, description: "Workflow id" },
    lang: {
      type: "string",
      description: "Snippet language: curl (default), node, or python",
      default: "curl",
    },
    environment: {
      type: "string",
      description:
        "Where the call runs: prod (default) or dev. Printed as the x-subkit-environment header.",
      default: "prod",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const profile = resolveProfile();
    const lang = String(args.lang);
    if (!isInvokeSnippetLanguage(lang)) {
      process.stderr.write(
        `invalid --lang '${lang}' (expected ${INVOKE_SNIPPET_LANGUAGES.join("|")})\n`,
      );
      process.exit(1);
    }
    const environment = String(args.environment);
    if (!isInvokeEnvironment(environment)) {
      process.stderr.write(
        `invalid --environment '${environment}' (expected ${INVOKE_ENVIRONMENTS.join("|")})\n`,
      );
      process.exit(1);
    }
    const workflowId = String(args.id);
    // The engine's snippet — the one the workflow page shows, with the
    // workflow's sample input and the engine's public address. Rendered here
    // only when the engine cannot answer (see lib/invoke-snippet-source.ts).
    let resolved: Awaited<ReturnType<typeof resolveInvokeSnippet>>;
    try {
      resolved = await resolveInvokeSnippet({
        client: new EngineClient({
          engine_url: profile.engine_url,
          api_key: profile.api_key,
          tenant: profile.active_tenant_id,
          fetchImpl: (input, init) =>
            globalThis.fetch(input, {
              ...init,
              signal: AbortSignal.timeout(INVOCATION_LOOKUP_TIMEOUT_MS),
            }),
        }),
        profileEngineUrl: profile.engine_url,
        workflowId,
        lang,
        environment,
      });
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
    const { snippet } = resolved;

    if (args.json) {
      printJson({
        workflow_id: workflowId,
        engine_url: resolved.engine_url,
        environment,
        route: "POST /v1/executions",
        lang,
        snippet,
        source: resolved.source,
        ...(resolved.local_reason ? { local_reason: resolved.local_reason } : {}),
      });
      return;
    }

    process.stdout.write(`${pc.bold("Run this workflow from your app:")}\n\n`);
    process.stdout.write(`${snippet}\n\n`);
    if (resolved.local_reason) {
      process.stdout.write(
        `${pc.yellow(`${LOCAL_SNIPPET_NOTES[resolved.local_reason]} This snippet uses your profile's engine URL and an empty input — fill in the workflow's input before you run it.`)}\n`,
      );
    }
    // The choice is stated, not implied: without the header the engine runs
    // in development, which is not where a pasted production call belongs.
    process.stdout.write(
      `${pc.dim(
        environment === "prod"
          ? "Runs in production. Pass --environment dev to target development."
          : "Runs in development. Pass --environment prod to target production.",
      )}\n`,
    );
    process.stdout.write(
      `${pc.dim("Set SK_API_KEY in your environment; the snippet never embeds your key in plaintext.")}\n`,
    );
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List workflows, grouped into catalog blocks" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    category: { type: "string", description: "Only this catalog block" },
    connector: { type: "string", description: "Only workflows using this connector (id or slug)" },
    flat: { type: "boolean", description: "One flat table instead of grouped blocks" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items, total, categories } = await client.listWorkflows({
        limit: Number(args.limit),
        ...(args.category ? { category: args.category } : {}),
        ...(args.connector ? { connector: args.connector } : {}),
      });
      const columns = WORKFLOW_LIST_COLUMNS;
      // JSON stays the engine's item verbatim; the table gets the synthesised
      // `runs_on` column (see list-columns.ts).
      const rows = args.json
        ? items
        : items.map((item) => ({
            ...item,
            runs_on: effectiveTriggerLabel(item as TriggerFields),
          }));
      // Grouping is the default because a flat 60-row catalog is what made
      // this unreadable; `--flat` restores the old view.
      if (args.flat || !categories?.length) {
        emitList(!!args.json, columns, rows);
      } else {
        emitGroupedList(!!args.json, columns, rows, categories);
      }
      // Ground-truth cardinality: never present a page as the universe.
      if (!args.json) {
        const blocks =
          !args.flat && categories?.length
            ? ` · ${categories.length} categor${categories.length === 1 ? "y" : "ies"}`
            : "";
        process.stdout.write(
          items.length < total
            ? `${pc.dim(`showing ${items.length} of ${total} workflows${blocks} — raise --limit to see all`)}\n`
            : `${pc.dim(`${total} workflow${total === 1 ? "" : "s"} total${blocks}`)}\n`,
        );
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a workflow by id" },
  args: {
    id: { type: "positional", required: false, description: "Workflow id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "workflow id",
        argValue: args.id,
        fetch: () => fetchWorkflowRows(client),
      });
      const workflow = await client.getWorkflow(id);
      printJson(workflow);
      // First-class summary of what really starts the workflow. Read from the
      // engine's `effective_trigger` (bound schedule / webhook rows beat the
      // definition), never from the declared `trigger` alone — that reported
      // schedules created with `sk schedules create` as "request". Always
      // print a line so an absent field is visible, not silent.
      process.stderr.write(
        `\n${pc.dim("trigger:")} ${effectiveTriggerLabel(workflow as TriggerFields)}\n`,
      );
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run a saved workflow, an inline draft definition, or a single step",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Workflow id or slug (omit when using --draft or --step)",
    },
    input: {
      type: "string",
      description:
        "Input JSON string. Prefix with `@` to read from a file (e.g. `--input @./payload.json`).",
    },
    "input-file": {
      type: "string",
      description:
        "Upload a file and substitute its ref into --input at key K. Format: K=<path>. Repeatable.",
    },
    draft: {
      type: "string",
      description: "Path to a draft WorkflowDef JSON file (no commit)",
    },
    step: {
      type: "string",
      description: "Path to a single StepDef JSON file (no workflow persistence)",
    },
    name: {
      type: "string",
      description: "Optional label for --draft runs (goes to executions.source_ref)",
    },
    slug: {
      type: "string",
      description: "Optional workflow_slug for --step runs (cosmetic)",
    },
    follow: {
      type: "boolean",
      description:
        "Queue the run and stream its progress live (step-by-step JSON lines). Saved workflows only.",
    },
    "idempotency-key": {
      type: "string",
      description:
        "Make this trigger safe to repeat: a second run with the same key is not started, the first run's id comes back instead. Saved workflows only.",
    },
  },
  async run({ args }) {
    const client = makeClient();
    const { readFileSync } = await import("node:fs");

    // --follow rides the queued (async) execution path, which the
    // engine only supports for saved workflows — draft and step runs
    // have no persisted workflow for a queue worker to rehydrate.
    if (args.follow && (args.draft || args.step)) {
      process.stderr.write(
        "--follow requires a saved workflow id; draft and step runs execute inline and return their result directly\n",
      );
      process.exit(1);
    }

    // Parse the --input JSON blob once; it is reused across all three
    // source kinds. The `@<path>` prefix opts into file-backed input
    // (e.g. `--input @./payload.json`), matching the convention curl
    // and gh use; the rest of the string is treated as a path.
    let input: unknown = null;
    if (args.input) {
      const raw = String(args.input);
      try {
        if (raw.startsWith("@")) {
          const filePath = raw.slice(1);
          input = JSON.parse(readFileSync(filePath, "utf8"));
        } else {
          input = JSON.parse(raw);
        }
      } catch (err) {
        process.stderr.write(
          `invalid JSON for --input: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    }

    // Parse repeatable --input-file flags. Citty surfaces a repeated
    // string-typed arg as `string | string[]` depending on how the
    // user supplied them; we normalise to an array of `K=<path>`
    // strings and split each. The substituted ref is the standard
    // `{ "$file": "fid_..." }` leaf — the workflow input_schema's
    // `file` typed leaf resolves it at the step boundary.
    const rawInputFile = (args as Record<string, unknown>)["input-file"];
    const inputFilePairs: string[] = Array.isArray(rawInputFile)
      ? rawInputFile.map((s) => String(s))
      : rawInputFile
        ? [String(rawInputFile)]
        : [];
    if (inputFilePairs.length > 0) {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        // `--input-file` only makes sense alongside a JSON-object input
        // (or no --input at all, in which case we synthesize one). A
        // scalar / array input has no key to set.
        input = {};
      }
      const inputObj = input as Record<string, unknown>;
      const client = makeClient();
      for (const pair of inputFilePairs) {
        const eq = pair.indexOf("=");
        if (eq <= 0) {
          process.stderr.write(`--input-file: expected 'K=<path>', got '${pair}'\n`);
          process.exit(1);
        }
        const key = pair.slice(0, eq);
        const filePath = pair.slice(eq + 1);
        try {
          const file = await uploadPath(client, filePath, { quiet: true });
          inputObj[key] = formatFileRef(file.id);
        } catch (err) {
          process.stderr.write(
            `--input-file ${key}: upload failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(exitCodeFor(err));
        }
      }
      input = inputObj;
    }

    try {
      // --step: run a single step definition directly.
      if (args.step) {
        const step = JSON.parse(readFileSync(String(args.step), "utf8")) as Record<string, unknown>;
        const body = {
          source: "step" as const,
          step,
          ...(args.slug ? { workflow_slug: String(args.slug) } : {}),
          ...(input !== null ? { input } : {}),
          request_source: "cli" as const,
        };
        printRunResult(await client.runExecution(body));
        return;
      }

      // --draft: run an inline workflow definition without persistence.
      if (args.draft) {
        const definition = JSON.parse(readFileSync(String(args.draft), "utf8")) as Record<
          string,
          unknown
        >;
        const body = {
          source: "draft" as const,
          definition,
          ...(args.name ? { name: String(args.name) } : {}),
          ...(input !== null ? { input } : {}),
          request_source: "cli" as const,
        };
        printRunResult(await client.runExecution(body));
        return;
      }

      // Saved workflow (default). An omitted id opens an interactive
      // picker in a TTY; non-TTY keeps the informative required error.
      const picked = await pickId({
        label: "workflow id or slug (positional, unless --draft or --step is provided)",
        argValue: args.id,
        fetch: () => fetchWorkflowRows(client),
      });
      // Accept a slug or exact name as well as a UUID — the engine's
      // saved-run route requires a UUID, so resolve before posting.
      const workflowId = await resolveWorkflowIdOrSlug(client, picked);
      // Use the engine's `RunExecutionBody` so the body shape is
      // type-checked against the canonical POST /v1/executions schema.
      const body: Extract<RunExecutionBody, { source: "saved" }> = {
        source: "saved",
        workflow_id: workflowId,
        ...(input !== null ? { input } : {}),
        ...(args["idempotency-key"] ? { idempotency_key: String(args["idempotency-key"]) } : {}),
        request_source: "cli",
      };
      if (args.follow) {
        // Queue the run (202 + execution_id), then tail its outbox
        // events live. The engine closes the stream right after the
        // terminal frame; the exit code mirrors the run's outcome.
        const queued = await client.runExecution({ ...body, async: true });
        if (queued.idempotent_replay) {
          process.stderr.write(
            `execution ${queued.execution_id} already started under this idempotency key (${queued.status}) — following\n`,
          );
        } else {
          process.stderr.write(`execution ${queued.execution_id} queued — following\n`);
        }
        const terminal = await tailExecution(client, queued.execution_id);
        if (terminal !== "succeeded") {
          process.stderr.write(
            `\n${pc.dim("Tip:")} sk executions get ${queued.execution_id} shows the full result\n`,
          );
        }
        process.exitCode = exitCodeForTerminalStatus(terminal);
        return;
      }
      printRunResult(await client.runExecution(body));
      // Discovery hint for saved-workflow runs: the same workflow can be
      // triggered from the operator's own app/CI via invoke-snippet.
      process.stderr.write(
        `\n${pc.dim("Tip:")} sk workflows invoke-snippet ${workflowId} --lang node\n`,
      );
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description:
      "Validate a draft WorkflowDef JSON file (structural + step schema checks). No execution, no persistence.",
  },
  args: {
    file: { type: "positional", required: true, description: "Path to WorkflowDef JSON" },
  },
  async run({ args }) {
    const { readFileSync } = await import("node:fs");
    const client = makeClient();
    try {
      const body = JSON.parse(readFileSync(String(args.file), "utf8")) as Record<string, unknown>;
      const res = await client.validateWorkflowDraft(body);
      if (res.ok) {
        process.stdout.write(`${pc.green("ok")}  workflow draft validates cleanly\n`);
        return;
      }
      process.stderr.write(`${pc.red("invalid")}  workflow draft:\n`);
      for (const e of res.errors ?? []) {
        process.stderr.write(`  ${pc.yellow(e.path)}  ${e.message}\n`);
      }
      process.exit(1);
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const previewCommand = defineCommand({
  meta: {
    name: "preview",
    description:
      "Preview a draft WorkflowDef by dry-running it via runExecution (source=draft). No persistence. Alias: dry-run.",
  },
  args: {
    file: { type: "positional", required: true, description: "Path to WorkflowDef JSON" },
    input: { type: "string", description: "Input JSON string" },
    name: { type: "string", description: "Optional label (goes to executions.source_ref)" },
  },
  async run({ args }) {
    const { readFileSync } = await import("node:fs");
    const client = makeClient();
    let input: unknown = null;
    if (args.input) {
      try {
        input = JSON.parse(args.input as string);
      } catch {
        process.stderr.write("invalid JSON for --input\n");
        process.exit(1);
      }
    }
    try {
      const definition = JSON.parse(readFileSync(String(args.file), "utf8")) as Record<
        string,
        unknown
      >;
      const body = {
        source: "draft" as const,
        definition,
        ...(args.name ? { name: String(args.name) } : {}),
        ...(input !== null ? { input } : {}),
        request_source: "cli" as const,
      };
      printRunResult(await client.runExecution(body));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a workflow" },
  args: {
    id: { type: "positional", required: false, description: "Workflow id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "workflow id",
        argValue: args.id,
        fetch: () => fetchWorkflowRows(client),
      });
      await client.deleteWorkflow(id);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const historyCommand = defineCommand({
  meta: { name: "history", description: "List committed versions of a workflow" },
  args: {
    id: { type: "positional", required: true, description: "Workflow id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listWorkflowVersions(args.id);
      emitList(
        !!args.json,
        ["version", "created_at", "note", "invalid"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const restoreCommand = defineCommand({
  meta: { name: "restore", description: "Restore a prior workflow version" },
  args: {
    id: { type: "positional", required: true, description: "Workflow id" },
    version: { type: "positional", required: true, description: "Version number" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.restoreWorkflowVersion(args.id, Number(args.version)));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

/**
 * Shared validate → preview → save pipeline for `create` and `update`.
 * `update` PUTs the full definition to /v1/workflows/{id} (the same body
 * shape as create); an unchanged definition does not rotate a version.
 */
async function saveWorkflowFromFile(
  target: { kind: "create" } | { kind: "update"; id: string },
  args: Record<string, unknown>,
): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const client = makeClient();
  const jsonMode = Boolean(args.json);
  try {
    {
      const body = JSON.parse(readFileSync(String(args.file), "utf8")) as Record<string, unknown>;
      const skip = Boolean(args["skip-checks"]);
      const intent = intentFromBody(body);
      intent.action = target.kind === "create" ? "Create" : "Update";
      await renderIntent(intent, { jsonMode });

      let previewExecutionId: string | undefined;

      if (!skip) {
        const validation = await client.validateWorkflowDraft(body);
        if (!validation.ok) {
          const firstErr = (validation.errors ?? [])[0];
          const detail = firstErr ? `${firstErr.path}: ${firstErr.message}` : "validation failed";
          const phases: PlanStep[] = [
            { id: "validate", label: "Validate", status: "failed", detail },
            { id: "preview", label: "Preview", status: "pending" },
            { id: "save", label: "Save", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
          process.exit(1);
        }

        let input: unknown = null;
        if (args.input) {
          try {
            input = JSON.parse(args.input as string);
          } catch {
            process.stderr.write("invalid JSON for --input\n");
            process.exit(1);
          }
        }

        const preview: RunExecutionResponse = await client.runExecution({
          source: "draft",
          definition: body,
          ...(input !== null ? { input } : {}),
          request_source: "cli",
        });

        const previewWarnings = (preview.warnings ?? []) as ReadonlyArray<{
          step_key?: string;
          code?: string;
          message?: string;
        }>;

        // Preview failure is a hard stop. Warnings are informational —
        // they print but the create proceeds. This decouples the
        // earlier conflated predicate ("warnings present ⇒ fail").
        if (preview.status !== "succeeded") {
          const phases: PlanStep[] = [
            { id: "validate", label: "Validate", status: "succeeded" },
            {
              id: "preview",
              label: "Preview",
              status: "failed",
              detail: `status=${preview.status}`,
            },
            { id: "save", label: "Save", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
          process.exit(1);
        }

        if (previewWarnings.length > 0) {
          const codes = previewWarnings
            .map((w) => w.code)
            .filter((c): c is string => typeof c === "string" && c.length > 0);
          const codeList = codes.length > 0 ? codes.join(", ") : "(no code)";
          const phases: PlanStep[] = [
            { id: "validate", label: "Validate", status: "succeeded" },
            {
              id: "preview",
              label: "Preview",
              status: "warning",
              detail: `${previewWarnings.length} warning(s): ${codeList}`,
            },
            { id: "save", label: "Save", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
        }

        previewExecutionId = preview.execution_id;
      } else if (!jsonMode) {
        process.stderr.write(
          `${pc.yellow("warning:")} --skip-checks active; no validate or preview was run\n`,
        );
      }

      const created = (await (target.kind === "create"
        ? client.createWorkflow(body)
        : client.updateWorkflow(target.id, body))) as Record<string, unknown> & {
        id?: string;
        version?: number;
        current_version?: number;
        name?: string;
      };
      printJson(created);

      // The HTTP response serializes the version as `current_version`
      // (`version` never existed on it — the summary used to print the
      // fallback 1 on every update).
      const version =
        typeof created.current_version === "number"
          ? created.current_version
          : typeof created.version === "number"
            ? created.version
            : 1;
      const summary: WorkflowSummary = {
        kind: "workflow",
        id: typeof created.id === "string" ? created.id : "(unknown)",
        version,
        name: typeof created.name === "string" ? created.name : intent.name,
        trigger: intent.trigger,
        action: target.kind === "create" ? "Created" : "Updated",
        ...(previewExecutionId ? { preview_execution_id: previewExecutionId } : {}),
      };
      await renderSummary(summary, { jsonMode });

      // Next-step hints: the exact run command (with the fresh id filled
      // in) plus the invoke-snippet for app/CI callers. Stderr keeps
      // stdout a clean JSON body for pipes; suppressed in jsonMode for
      // the same reason.
      if (!jsonMode && summary.id !== "(unknown)") {
        process.stderr.write(
          `\n${pc.dim("Next:")} sk workflows run ${summary.id} --follow\n` +
            `${pc.dim("Tip:")} sk workflows invoke-snippet ${summary.id} --lang node\n`,
        );
      }
    }
  } catch (err) {
    reportCommandError(err, { json: jsonMode });
  }
}

const SAVE_ARGS = {
  file: { type: "string", required: true, description: "Path to WorkflowDef JSON" },
  "skip-checks": {
    type: "boolean",
    description:
      "Skip the validate+preview pre-flight entirely (NOT recommended). Preview warnings never block; only validation errors and preview failures do.",
  },
  input: {
    type: "string",
    description: "Input JSON string passed to the preview dry-run.",
  },
  json: { type: "boolean", description: "JSON-only output (suppresses narration)" },
} as const;

const createCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Create a workflow from a JSON file. Runs `validate` and `preview` by default; pass --skip-checks to bypass.",
  },
  args: { ...SAVE_ARGS },
  async run({ args }) {
    await saveWorkflowFromFile({ kind: "create" }, args as Record<string, unknown>);
  },
});

const updateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Update a workflow from a JSON file (PUT the full definition). Runs `validate` and `preview` by default; pass --skip-checks to bypass. An unchanged definition does not rotate a version.",
  },
  args: {
    id: { type: "positional", required: true, description: "Workflow id" },
    ...SAVE_ARGS,
  },
  async run({ args }) {
    await saveWorkflowFromFile(
      { kind: "update", id: String((args as Record<string, unknown>).id) },
      args as Record<string, unknown>,
    );
  },
});

export const workflowsCommand = defineCommand({
  meta: { name: "workflows", description: "Manage workflows" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    run: runCommand,
    validate: validateCommand,
    preview: previewCommand,
    "dry-run": previewCommand,
    delete: deleteCommand,
    history: historyCommand,
    restore: restoreCommand,
    create: createCommand,
    update: updateCommand,
    "invoke-snippet": invokeSnippetCommand,
  },
});
