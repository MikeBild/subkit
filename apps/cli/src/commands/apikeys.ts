// `subkit apikeys ...`

import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List API keys" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listApiKeys();
    emitList(
      asJson,
      ["id", "prefix", "user_id", "system_account_id", "created_at", "last_used_at"],
      body.items,
    );
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Issue an API key" },
  args: {
    ...clientArgs,
    owner: { type: "string", description: "user|system_account:<uuid>", required: true },
    scopes: { type: "string", description: "Comma-separated scopes" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const raw = args.owner as string;
    const [kind, id] = raw.split(":");
    if (!kind || !id || (kind !== "user" && kind !== "system_account")) {
      throw new Error("--owner must be user:<uuid> or system_account:<uuid>");
    }
    const body: Record<string, unknown> = {
      owner_kind: kind,
      owner_id: id,
    };
    if (typeof args.scopes === "string" && args.scopes) {
      body.scopes = (args.scopes as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const row = await client.issueApiKey(body);
    emitOne(asJson, row);
  },
});

const rotateCmd = defineCommand({
  meta: { name: "rotate", description: "Rotate an API key" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "API key id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.rotateApiKey(args.id as string, {});
    emitOne(asJson, row);
  },
});

const revokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke an API key" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "API key id", required: true },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    await client.revokeApiKey(args.id as string);
    process.stdout.write(`revoked ${args.id}\n`);
  },
});

export const apikeysCommand = defineCommand({
  meta: { name: "apikeys", description: "API key management" },
  subCommands: { list: listCmd, create: createCmd, rotate: rotateCmd, revoke: revokeCmd },
});
