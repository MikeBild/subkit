import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient, type RunExecutionResponse } from "../engine-client.ts";

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
      printJson(await client.getWorkflow(args.id));
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
      description: "Skip the validate+preview pre-flight (NOT recommended).",
    },
    input: {
      type: "string",
      description: "Input JSON string passed to the preview dry-run.",
    },
  },
  async run({ args }) {
    const { readFileSync } = await import("node:fs");
    const client = makeClient();
    try {
      const body = JSON.parse(readFileSync(String(args.file), "utf8")) as Record<string, unknown>;
      const skip = Boolean((args as Record<string, unknown>)["skip-checks"]);
      if (!skip) {
        const validation = await client.validateWorkflowDraft(body);
        if (!validation.ok) {
          process.stderr.write(`${pc.red("invalid")}  workflow draft:\n`);
          for (const e of validation.errors ?? []) {
            process.stderr.write(`  ${pc.yellow(e.path)}  ${e.message}\n`);
          }
          process.stderr.write(
            `Re-run with --skip-checks to force, or fix the errors above and try again.\n`,
          );
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
        const preview = await client.runExecution({
          source: "draft",
          definition: body,
          ...(input !== null ? { input } : {}),
          request_source: "cli",
        });
        if ((preview.warnings ?? []).length > 0) {
          process.stderr.write(`${pc.yellow("preview warnings:")}\n`);
          for (const w of preview.warnings ?? []) {
            const ww = w as { step_key?: string; code?: string; message?: string };
            process.stderr.write(
              `  ${pc.yellow("WARN")} step=${ww.step_key ?? "(run)"} code=${ww.code ?? "unknown"} msg=${ww.message ?? ""}\n`,
            );
          }
        }
        if (preview.status !== "succeeded") {
          process.stderr.write(
            `preview did not succeed (status=${preview.status}). Re-run with --skip-checks to force.\n`,
          );
          process.exit(1);
        }
      } else {
        process.stderr.write(
          `${pc.yellow("warning:")} --skip-checks active; no validate or preview was run\n`,
        );
      }
      printJson(await client.createWorkflow(body));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
