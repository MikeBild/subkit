import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient, type RunExecutionResponse } from "../engine-client.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type {
  PlanStep,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "../render/types.ts";
import { formatFileRef } from "../utils/file-ref.ts";
import { uploadPath } from "./files.ts";

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
  const definition = (body.definition as Record<string, unknown>) ?? {};
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

// In jsonMode the contract is "stdout = JSON, stderr = silent" so a
// downstream consumer can pipe the create command into jq or another
// script. The error path must therefore route the failure message to
// stdout as `{ "error": <msg> }` and keep stderr empty; otherwise the
// pipe sees a JSON body on success and unparseable text on failure.
// After writing the error envelope, the function re-throws so the
// top-level `sk` dispatcher sets `process.exitCode` — handlers must
// never short-circuit via process.exit (see the discipline test in
// `tests/commands/knowledge-sources-error-discipline.test.ts`).
function reportError(err: unknown, jsonMode: boolean): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
  } else {
    process.stderr.write(`${msg}\n`);
  }
  throw err instanceof Error ? err : new Error(msg);
}

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List workflows" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listWorkflows({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "name", "status", "updated_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a workflow by id" },
  args: {
    id: { type: "positional", required: true, description: "Workflow id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const workflow = await client.getWorkflow(args.id);
      printJson(workflow);
      // First-class summary of the workflow-level trigger so operators
      // don't have to grep the JSON. Always print a line so absence
      // (which would be the bug signature if the trigger field stops
      // round-tripping through commit) is *visible*, not silent.
      const definition = (workflow as { definition?: Record<string, unknown> }).definition ?? {};
      const trigger = (definition as { trigger?: Record<string, unknown> }).trigger;
      const kindRaw =
        trigger && typeof trigger === "object" && typeof trigger.kind === "string"
          ? trigger.kind
          : "request";
      if (kindRaw === "schedule" && trigger) {
        const cron = typeof trigger.cron === "string" ? trigger.cron : "?";
        const tz = typeof trigger.tz === "string" ? trigger.tz : "UTC";
        process.stderr.write(
          `\n${pc.dim("trigger:")} ${pc.cyan("schedule")}  cron=${cron}  tz=${tz}\n`,
        );
      } else if (kindRaw === "webhook" && trigger) {
        const source = typeof trigger.source === "string" ? trigger.source : "?";
        const events = Array.isArray(trigger.events) ? trigger.events.join(",") : "?";
        process.stderr.write(
          `\n${pc.dim("trigger:")} ${pc.cyan("webhook")}  source=${source}  events=${events}\n`,
        );
      } else {
        process.stderr.write(`\n${pc.dim("trigger:")} request\n`);
      }
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      description: "Workflow id (omit when using --draft or --step)",
    },
    input: { type: "string", description: "Input JSON string" },
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
  },
  async run({ args }) {
    const client = makeClient();

    // Parse the --input JSON blob once; it is reused across all three
    // source kinds.
    let input: unknown = null;
    if (args.input) {
      try {
        input = JSON.parse(args.input as string);
      } catch {
        process.stderr.write("invalid JSON for --input\n");
        process.exit(1);
      }
    }

    const { readFileSync } = await import("node:fs");

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

      // Saved workflow (default).
      if (!args.id) {
        process.stderr.write(
          "workflow id is required (positional) unless --draft or --step is provided\n",
        );
        process.exit(1);
      }
      const body = {
        source: "saved" as const,
        workflow_id: String(args.id),
        ...(input !== null ? { input } : {}),
        request_source: "cli" as const,
      };
      printRunResult(await client.runExecution(body));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a workflow" },
  args: {
    id: { type: "positional", required: true, description: "Workflow id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteWorkflow(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
        ["version", "committed_at", "committed_by"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Create a workflow from a JSON file. Runs `validate` and `preview` by default; pass --skip-checks to bypass.",
  },
  args: {
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
  },
  async run({ args }) {
    const { readFileSync } = await import("node:fs");
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      const body = JSON.parse(readFileSync(String(args.file), "utf8")) as Record<string, unknown>;
      const skip = Boolean((args as Record<string, unknown>)["skip-checks"]);
      const intent = intentFromBody(body);
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

      const created = (await client.createWorkflow(body)) as Record<string, unknown> & {
        id?: string;
        version?: number;
        name?: string;
      };
      printJson(created);

      const summary: WorkflowSummary = {
        kind: "workflow",
        id: typeof created.id === "string" ? created.id : "(unknown)",
        version: typeof created.version === "number" ? created.version : 1,
        name: typeof created.name === "string" ? created.name : intent.name,
        trigger: intent.trigger,
        ...(previewExecutionId ? { preview_execution_id: previewExecutionId } : {}),
      };
      await renderSummary(summary, { jsonMode });
    } catch (err) {
      reportError(err, jsonMode);
    }
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
  },
});
