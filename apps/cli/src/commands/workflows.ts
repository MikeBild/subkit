// `subkit workflows ...` — list, get, run, delete, history, restore,
// create, export, import.

import { readFileSync, writeFileSync } from "node:fs";
import { defineCommand } from "citty";
import type { EngineClient, WorkflowSummary } from "../engine-client.ts";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne, printJson } from "../utils/format.ts";

// ---------- pure handlers (easy to unit test) ----------

export async function runList(
  client: EngineClient,
  asJson: boolean,
  query: { limit?: number; status?: "draft" | "active" | "archived" } = {},
): Promise<number> {
  const body = await client.listWorkflows(query);
  const rows = body.items.map((w) => ({
    id: w.id,
    slug: w.slug,
    name: w.name,
    lifecycle: w.lifecycle,
    version: w.current_version,
    updated_at: w.updated_at,
  }));
  emitList(asJson, ["id", "slug", "name", "lifecycle", "version", "updated_at"], rows);
  return 0;
}

export async function runGet(client: EngineClient, asJson: boolean, id: string): Promise<number> {
  const wf = await client.getWorkflow(id);
  emitOne(asJson, serialize(wf));
  return 0;
}

export async function runRun(
  client: EngineClient,
  asJson: boolean,
  id: string,
  input: unknown,
): Promise<number> {
  const body = await client.runWorkflow(id, { input, request_source: "cli" }, true);
  emitOne(asJson, {
    id: body.id,
    status: body.status,
    output: body.output,
    error: body.error,
  });
  return 0;
}

export async function runHistory(
  client: EngineClient,
  asJson: boolean,
  id: string,
): Promise<number> {
  const body = await client.workflowHistory(id);
  const rows = body.items.map((v) => ({
    version: v.version,
    id: v.id,
    note: v.note ?? "",
    created_at: v.created_at,
  }));
  emitList(asJson, ["version", "id", "note", "created_at"], rows);
  return 0;
}

function serialize(wf: WorkflowSummary): Record<string, unknown> {
  return {
    id: wf.id,
    tenant_id: wf.tenant_id,
    slug: wf.slug,
    name: wf.name,
    lifecycle: wf.lifecycle,
    current_version: wf.current_version,
    step_count: wf.steps.length,
    updated_at: wf.updated_at,
  };
}

// ---------- citty subcommands ----------

const listCmd = defineCommand({
  meta: { name: "list", description: "List workflows" },
  args: {
    ...clientArgs,
    limit: { type: "string", description: "Max rows (default 50)" },
    status: { type: "string", description: "Lifecycle filter" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const q: { limit?: number; status?: "draft" | "active" | "archived" } = {};
    if (typeof args.limit === "string" && args.limit) q.limit = Number(args.limit);
    if (typeof args.status === "string" && args.status) {
      q.status = args.status as "draft" | "active" | "archived";
    }
    await runList(client, asJson, q);
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch a workflow" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Workflow id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await runGet(client, asJson, args.id as string);
  },
});

const runCmd = defineCommand({
  meta: { name: "run", description: "Run a workflow (sync)" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Workflow id", required: true },
    input: { type: "string", description: "Input JSON (inline)" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const raw = typeof args.input === "string" ? args.input : undefined;
    const input: unknown = raw ? (JSON.parse(raw) as unknown) : null;
    await runRun(client, asJson, args.id as string, input);
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a workflow" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Workflow id", required: true },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    await client.deleteWorkflow(args.id as string);
    process.stdout.write(`deleted ${args.id}\n`);
  },
});

const historyCmd = defineCommand({
  meta: { name: "history", description: "Show workflow version history" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Workflow id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await runHistory(client, asJson, args.id as string);
  },
});

const restoreCmd = defineCommand({
  meta: { name: "restore", description: "Restore a workflow version" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Workflow id", required: true },
    version: { type: "positional", description: "Version number", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const wf = await client.restoreWorkflow(args.id as string, Number(args.version));
    emitOne(asJson, serialize(wf));
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a workflow from a JSON file" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to WorkflowDef JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const wf = await client.createWorkflow(body);
    emitOne(asJson, serialize(wf));
  },
});

const exportCmd = defineCommand({
  meta: { name: "export", description: "Print a workflow as JSON" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Workflow id", required: true },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    const wf = await client.getWorkflow(args.id as string);
    printJson(wf);
  },
});

const importCmd = defineCommand({
  meta: { name: "import", description: "Import a workflow from a JSON file" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to WorkflowDef JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const wf = await client.createWorkflow(body);
    emitOne(asJson, serialize(wf));
    // Ensure writeFileSync stays reachable so the `export > file.json`
    // shell redirect story is discoverable from the source.
    void writeFileSync;
  },
});

export const workflowsCommand = defineCommand({
  meta: { name: "workflows", description: "Workflow CRUD + run" },
  subCommands: {
    list: listCmd,
    get: getCmd,
    run: runCmd,
    delete: deleteCmd,
    history: historyCmd,
    restore: restoreCmd,
    create: createCmd,
    export: exportCmd,
    import: importCmd,
  },
});
