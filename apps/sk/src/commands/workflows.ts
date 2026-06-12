import { exitCodeFor, reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  EngineClient,
  type RunExecutionBody,
  type RunExecutionResponse,
} from "../engine-client.ts";
import { pickId } from "../lib/pick.ts";
import { exitCodeForTerminalStatus, tailExecution } from "../lib/tail-execution.ts";
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

type SnippetLang = "curl" | "node" | "python";

/** Render an authenticated, copy-paste snippet that runs a saved
 *  workflow against the engine's canonical `POST /v1/executions`
 *  surface (the same route `sk workflows run` posts to — see
 *  `client.runExecution`). The API key is always a `$SK_API_KEY`
 *  placeholder; the real key is never printed. The engine URL, tenant
 *  header, and workflow id are real so the snippet is ready to paste. */
function renderInvokeSnippet(opts: {
  lang: SnippetLang;
  engineUrl: string;
  workflowId: string;
  tenant: string | null;
}): string {
  const { lang, engineUrl, workflowId, tenant } = opts;
  const url = `${engineUrl.replace(/\/+$/, "")}/v1/executions`;
  const body = {
    source: "saved",
    workflow_id: workflowId,
    request_source: "api",
    input: {},
  };

  if (lang === "curl") {
    const lines = [`curl -sS -X POST '${url}' \\`, `  -H 'authorization: Bearer '"$SK_API_KEY" \\`];
    if (tenant) lines.push(`  -H 'x-subkit-tenant: ${tenant}' \\`);
    lines.push(`  -H 'content-type: application/json' \\`);
    lines.push(`  -d '${JSON.stringify(body)}'`);
    return lines.join("\n");
  }

  if (lang === "node") {
    const headers: Record<string, string> = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted verbatim into the user's Node snippet as a template-literal placeholder.
      authorization: "Bearer ${process.env.SK_API_KEY}",
      "content-type": "application/json",
    };
    if (tenant) headers["x-subkit-tenant"] = tenant;
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `      "${k}": \`${v}\`,`)
      .join("\n");
    return [
      `const res = await fetch("${url}", {`,
      `  method: "POST",`,
      `  headers: {`,
      headerLines,
      `  },`,
      `  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}),`,
      `});`,
      `const result = await res.json();`,
      `console.log(result);`,
    ].join("\n");
  }

  // python (requests)
  const headerEntries: string[] = [
    `        "authorization": f"Bearer {os.environ['SK_API_KEY']}",`,
    `        "content-type": "application/json",`,
  ];
  if (tenant) headerEntries.push(`        "x-subkit-tenant": "${tenant}",`);
  return [
    `import os`,
    `import requests`,
    ``,
    `res = requests.post(`,
    `    "${url}",`,
    `    headers={`,
    ...headerEntries,
    `    },`,
    `    json=${JSON.stringify(body)},`,
    `)`,
    `print(res.json())`,
  ].join("\n");
}

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
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const profile = resolveProfile();
    const lang = String(args.lang) as SnippetLang;
    if (!["curl", "node", "python"].includes(lang)) {
      process.stderr.write(`invalid --lang '${lang}' (expected curl|node|python)\n`);
      process.exit(1);
    }
    const workflowId = String(args.id);
    const engineUrl = profile.engine_url;
    const tenant = profile.active_tenant_id ?? null;
    const snippet = renderInvokeSnippet({ lang, engineUrl, workflowId, tenant });

    if (args.json) {
      printJson({
        workflow_id: workflowId,
        engine_url: engineUrl,
        ...(tenant ? { tenant } : {}),
        route: "POST /v1/executions",
        lang,
        snippet,
      });
      return;
    }

    process.stdout.write(`${pc.bold("Run this workflow from your app:")}\n\n`);
    process.stdout.write(`${snippet}\n\n`);
    process.stdout.write(
      `${pc.dim("Set SK_API_KEY in your environment; the snippet never embeds your key in plaintext.")}\n`,
    );
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List workflows" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items, total } = await client.listWorkflows({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "name", "status", "updated_at"],
        items as Record<string, unknown>[],
      );
      // Ground-truth cardinality: never present a page as the universe.
      if (!args.json) {
        process.stdout.write(
          items.length < total
            ? `${pc.dim(`showing ${items.length} of ${total} workflows — raise --limit to see all`)}\n`
            : `${pc.dim(`${total} workflow${total === 1 ? "" : "s"} total`)}\n`,
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
      description: "Workflow id (omit when using --draft or --step)",
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
      const workflowId = await pickId({
        label: "workflow id (positional, unless --draft or --step is provided)",
        argValue: args.id,
        fetch: () => fetchWorkflowRows(client),
      });
      // Use the engine's `RunExecutionBody` so the body shape is
      // type-checked against the canonical POST /v1/executions schema.
      const body: Extract<RunExecutionBody, { source: "saved" }> = {
        source: "saved",
        workflow_id: workflowId,
        ...(input !== null ? { input } : {}),
        request_source: "cli",
      };
      if (args.follow) {
        // Queue the run (202 + execution_id), then tail its outbox
        // events live. The engine closes the stream right after the
        // terminal frame; the exit code mirrors the run's outcome.
        const queued = await client.runExecution({ ...body, async: true });
        process.stderr.write(`execution ${queued.execution_id} queued — following\n`);
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
        ["version", "committed_at", "committed_by"],
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
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
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
    "invoke-snippet": invokeSnippetCommand,
  },
});
