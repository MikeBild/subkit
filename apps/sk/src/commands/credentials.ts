import { reportCommandError } from "@cli-core/errors";
import { emitList } from "@cli-core/format";
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
  meta: { name: "list", description: "List credentials for a connector" },
  args: {
    "connector-id": { type: "positional", required: true, description: "Connector id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const connector = (await client.getConnector(args["connector-id"])) as Record<
        string,
        unknown
      >;
      const credentials = (connector.credentials ?? []) as Record<string, unknown>[];
      emitList(!!args.json, ["id", "kind", "created_at"], credentials);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const rotateCommand = defineCommand({
  meta: { name: "rotate", description: "Rotate a credential" },
  args: {
    "credential-id": { type: "positional", required: true, description: "Credential id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.rotateCredential(args["credential-id"]);
      process.stdout.write("rotated\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a credential" },
  args: {
    "credential-id": { type: "positional", required: true, description: "Credential id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteCredential(args["credential-id"]);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const credentialsCommand = defineCommand({
  meta: { name: "credentials", description: "Manage connector credentials" },
  subCommands: {
    list: listCommand,
    rotate: rotateCommand,
    delete: deleteCommand,
  },
});
