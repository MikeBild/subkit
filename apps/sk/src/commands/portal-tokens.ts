import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List portal tokens" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listPortalTokens();
        emitList(
          !!args.json,
          ["id", "name", "user_id", "created_at", "expires_at"],
          items as Record<string, unknown>[],
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Issue a portal token (shown once)" },
  args: {
    name: { type: "string", required: true, description: "Token name" },
    "user-id": { type: "string", description: "User id to bind the token to" },
    expires: { type: "string", description: "Expiry — ISO-8601 timestamp" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const body: Record<string, unknown> = { name: String(args.name) };
      if (args["user-id"]) body.user_id = String(args["user-id"]);
      if (args.expires) body.expires_at = String(args.expires);
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
