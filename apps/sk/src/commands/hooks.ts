import { readFileSync } from "node:fs";
import { reportCommandError } from "@cli-core/errors";
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
  meta: { name: "list", description: "List inbound webhook bindings" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listHooksInbound();
      emitList(
        !!args.json,
        ["id", "slug", "workflow_id", "verifier", "active"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an inbound webhook binding" },
  args: {
    id: { type: "positional", required: true, description: "Hook id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getHookInbound(args.id));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const VERIFIERS = ["standard", "github", "stripe", "hmac"] as const;

function readSource(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

const createCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Create an inbound webhook binding. The signing secret is read from a file (or - for stdin), never from an argument.",
  },
  args: {
    slug: { type: "string", required: true, description: "Public path: POST /v1/hooks/<slug>" },
    "workflow-id": { type: "string", required: true, description: "Workflow id to bind" },
    verifier: {
      type: "string",
      default: "standard",
      description: `Signature scheme: ${VERIFIERS.join(" | ")}`,
    },
    "secret-file": {
      type: "string",
      required: true,
      description: "File holding the shared signing secret (- reads stdin)",
    },
    "config-file": {
      type: "string",
      description:
        'JSON file for native_verifier_config, e.g. {"hmac": {...}} for the hmac verifier',
    },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const verifier = String(args.verifier);
      if (!(VERIFIERS as readonly string[]).includes(verifier)) {
        throw new Error(`--verifier must be one of ${VERIFIERS.join(", ")}`);
      }
      const secret = readSource(String(args["secret-file"])).trim();
      if (!secret) throw new Error("--secret-file is empty");
      const body: Record<string, unknown> = {
        slug: args.slug,
        workflow_id: args["workflow-id"],
        verifier,
        secret,
      };
      if (args["config-file"]) {
        body.native_verifier_config = JSON.parse(readSource(String(args["config-file"])));
      }
      printJson(await client.createHookInbound(body));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete an inbound webhook binding" },
  args: {
    id: { type: "positional", required: true, description: "Hook id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteHookInbound(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const hooksCommand = defineCommand({
  meta: { name: "hooks", description: "Manage inbound webhook bindings" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    create: createCommand,
    delete: deleteCommand,
  },
});
