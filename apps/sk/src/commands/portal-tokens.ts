import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

type Schemas = components["schemas"];

const listCmd = defineCommand({
  meta: { name: "list", description: "List portal tokens" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listPortalTokens();
        emitList(!!args.json, ["id", "enduser_ref", "prefix", "created_at", "expires_at"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

function csv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const createCmd = defineCommand({
  meta: { name: "create", description: "Issue a portal token (shown once)" },
  args: {
    "user-id": { type: "string", required: true, description: "User id to bind the token to" },
    workflows: {
      type: "string",
      required: true,
      description: "Comma-separated workflow ids the token may run",
    },
    ttl: { type: "string", description: "Token lifetime in minutes" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const allowed = csv(args.workflows);
      if (allowed.length === 0) throw new Error("--workflows must name at least one workflow id");
      const body: Schemas["IssuePortalTokenBody"] = {
        user_id: String(args["user-id"]),
        allowed_workflows: allowed,
      };
      if (args.ttl) {
        const ttl = Number(args.ttl);
        if (!Number.isInteger(ttl) || ttl <= 0) {
          throw new Error("--ttl must be a positive integer (minutes)");
        }
        body.ttl_minutes = ttl;
      }
      const result = await client.issuePortalToken(body);
      process.stderr.write("warning: the token value is shown only once — store it securely\n");
      printJson(result);
    });
  },
});

const revokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke a portal token" },
  args: { id: { type: "positional", required: true, description: "Token id" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.revokePortalToken(String(args.id));
      process.stdout.write("revoked\n");
    });
  },
});

export const portalTokensCommand = defineCommand({
  meta: { name: "portal-tokens", description: "Manage portal tokens" },
  subCommands: { list: listCmd, create: createCmd, revoke: revokeCmd },
});
