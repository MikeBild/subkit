import { readFileSync } from "node:fs";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import type { CreateWebhookInboundBody } from "../engine-client/events.ts";
import { hookApprovalNoticeFor } from "../lib/hook-approval.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List inbound webhook bindings" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listHooksInbound();
        emitList(!!args.json, ["id", "slug", "workflow_id", "verifier", "active"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an inbound webhook binding" },
  args: {
    id: { type: "positional", required: true, description: "Hook id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.getHookInbound(args.id));
    });
  },
});

const VERIFIERS = [
  "standard",
  "github",
  "stripe",
  "hmac",
] as const satisfies readonly CreateWebhookInboundBody["verifier"][];

function isVerifier(value: string): value is (typeof VERIFIERS)[number] {
  return (VERIFIERS as readonly string[]).includes(value);
}

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
    return withCommandErrors(async () => {
      const verifier = String(args.verifier);
      if (!isVerifier(verifier)) {
        throw new Error(`--verifier must be one of ${VERIFIERS.join(", ")}`);
      }
      const secret = readSource(String(args["secret-file"])).trim();
      if (!secret) throw new Error("--secret-file is empty");
      const body: CreateWebhookInboundBody = {
        slug: args.slug,
        workflow_id: args["workflow-id"],
        verifier,
        secret,
      };
      if (args["config-file"]) {
        body.native_verifier_config = JSON.parse(readSource(String(args["config-file"])));
      }
      const created = await client.createHookInbound(body);
      printJson(created);
      process.stderr.write(await hookApprovalNoticeFor(client, created.workflow_id, created.id));
    });
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete an inbound webhook binding" },
  args: {
    id: { type: "positional", required: true, description: "Hook id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.deleteHookInbound(args.id);
      process.stdout.write("deleted\n");
    });
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
