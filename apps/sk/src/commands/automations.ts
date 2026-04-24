import { readFileSync } from "node:fs";
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

function parseJsonInput(input?: string): unknown {
  if (!input) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("invalid JSON for --input");
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List automations" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listAutomations({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "name", "lifecycle", "current_version", "updated_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an automation by id" },
  args: {
    id: { type: "positional", required: true, description: "Automation id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getAutomation(String(args.id)));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Create an automation from a JSON file" },
  args: {
    file: { type: "string", required: true, description: "Path to a WorkflowDef JSON file" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.createAutomation(readJsonFile(String(args.file))));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update an automation from a JSON file" },
  args: {
    id: { type: "positional", required: true, description: "Automation id" },
    file: { type: "string", required: true, description: "Path to a WorkflowDef JSON file" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.updateAutomation(String(args.id), readJsonFile(String(args.file))));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete an automation" },
  args: {
    id: { type: "positional", required: true, description: "Automation id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteAutomation(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const previewCommand = defineCommand({
  meta: { name: "preview", description: "Preview an inline automation definition" },
  args: {
    file: { type: "string", required: true, description: "Path to a WorkflowDef JSON file" },
    input: { type: "string", description: "Input JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.previewAutomation({
          definition: readJsonFile(String(args.file)),
          ...(args.input ? { input: parseJsonInput(String(args.input)) } : {}),
          request_source: "cli",
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const runCommand = defineCommand({
  meta: { name: "run", description: "Run a saved automation inline" },
  args: {
    id: { type: "positional", required: true, description: "Automation id" },
    input: { type: "string", description: "Input JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.runAutomation(String(args.id), {
          ...(args.input ? { input: parseJsonInput(String(args.input)) } : {}),
          request_source: "cli",
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const diffCommand = defineCommand({
  meta: { name: "diff", description: "Preview saved automation changes and the inline run result" },
  args: {
    id: { type: "positional", required: true, description: "Automation id" },
    file: { type: "string", required: true, description: "Path to a WorkflowDef JSON file" },
    input: { type: "string", description: "Input JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.previewAutomationChanges(String(args.id), {
          definition: readJsonFile(String(args.file)),
          ...(args.input ? { input: parseJsonInput(String(args.input)) } : {}),
          request_source: "cli",
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const applyCommand = defineCommand({
  meta: { name: "apply", description: "Apply and save proposed automation changes" },
  args: {
    id: { type: "positional", required: true, description: "Automation id" },
    file: { type: "string", required: true, description: "Path to a WorkflowDef JSON file" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.applyAutomationChanges(String(args.id), {
          definition: readJsonFile(String(args.file)),
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const applyAndRunCommand = defineCommand({
  meta: { name: "apply-and-run", description: "Apply changes, save them, and run inline" },
  args: {
    id: { type: "positional", required: true, description: "Automation id" },
    file: { type: "string", required: true, description: "Path to a WorkflowDef JSON file" },
    input: { type: "string", description: "Input JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.applyAndRunAutomation(String(args.id), {
          definition: readJsonFile(String(args.file)),
          ...(args.input ? { input: parseJsonInput(String(args.input)) } : {}),
          request_source: "cli",
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const automationsCommand = defineCommand({
  meta: { name: "automations", description: "Manage direct automation objects" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    create: createCommand,
    update: updateCommand,
    delete: deleteCommand,
    preview: previewCommand,
    run: runCommand,
    diff: diffCommand,
    apply: applyCommand,
    "apply-and-run": applyAndRunCommand,
  },
});
