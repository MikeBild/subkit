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

const listCmd = defineCommand({
  meta: { name: "list", description: "List API keys" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listApiKeys();
      emitList(
        !!args.json,
        ["id", "name", "prefix", "created_at", "expires_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Issue a new API key (shown once)" },
  args: {
    name: { type: "string", required: true, description: "Key name" },
    expires: { type: "string", description: "Expiry — ISO-8601 timestamp" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const body: Record<string, unknown> = { name: String(args.name) };
      if (args.expires) body.expires_at = String(args.expires);
      const result = await client.issueApiKey(body);
      process.stderr.write("warning: the key value is shown only once — store it securely\n");
      printJson(result);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const rotateCmd = defineCommand({
  meta: { name: "rotate", description: "Rotate an API key (new key shown once)" },
  args: { id: { type: "positional", required: true, description: "Key id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const result = await client.rotateApiKey(String(args.id));
      process.stderr.write("warning: the new key value is shown only once — store it securely\n");
      printJson(result);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const revokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke an API key" },
  args: { id: { type: "positional", required: true, description: "Key id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.revokeApiKey(String(args.id));
      process.stdout.write("revoked\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const apiKeysCommand = defineCommand({
  meta: { name: "apikeys", description: "Manage API keys" },
  subCommands: { list: listCmd, create: createCmd, rotate: rotateCmd, revoke: revokeCmd },
});
