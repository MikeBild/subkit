// `subkit portal-tokens ...`

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List portal tokens" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listPortalTokens();
    emitList(asJson, ["id", "enduser_ref", "prefix", "expires_at", "revoked_at"], body.items);
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Issue a portal token from JSON" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to issue body JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const row = await client.issuePortalToken(body);
    emitOne(asJson, row);
  },
});

const revokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke a portal token" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Portal token id", required: true },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    await client.revokePortalToken(args.id as string);
    process.stdout.write(`revoked ${args.id}\n`);
  },
});

export const portalTokensCommand = defineCommand({
  meta: { name: "portal-tokens", description: "Portal token management" },
  subCommands: { list: listCmd, create: createCmd, revoke: revokeCmd },
});
