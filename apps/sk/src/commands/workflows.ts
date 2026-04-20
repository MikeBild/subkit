import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

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
  meta: { name: "run", description: "Run a workflow" },
  args: {
    id: { type: "positional", required: true, description: "Workflow id" },
    input: { type: "string", description: "Input JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    let input: Record<string, unknown> = {};
    if (args.input) {
      try {
        input = JSON.parse(args.input as string) as Record<string, unknown>;
      } catch {
        process.stderr.write("invalid JSON for --input\n");
        process.exit(1);
      }
    }
    try {
      printJson(await client.runWorkflow(args.id, input));
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
  meta: { name: "create", description: "Create a workflow" },
  args: {
    name: { type: "string", required: true, description: "Workflow name" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.createWorkflow({ name: args.name }));
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
    delete: deleteCommand,
    history: historyCommand,
    restore: restoreCommand,
    create: createCommand,
  },
});
