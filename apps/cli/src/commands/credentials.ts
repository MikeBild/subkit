// `subkit credentials list <connector_id>` | `rotate <id>`
//
// The engine does not yet expose a list/rotate endpoint for credentials
// directly (they're managed through `/v1/connectors/:id/credentials`).
// We surface the `list` command by reading the parent connector; rotate
// is a stub that hits the rotate path when the engine adds it.

import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "Show the credential bound to a connector" },
  args: {
    ...clientArgs,
    connector_id: { type: "positional", description: "Connector id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const c = await client.getConnector(args.connector_id as string);
    emitOne(asJson, {
      connector_id: c.id,
      auth_type: c.auth_type,
      slug: c.slug,
      environment: c.environment,
    });
  },
});

const rotateCmd = defineCommand({
  meta: { name: "rotate", description: "Rotate a credential (placeholder)" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Credential id", required: true },
  },
  async run() {
    process.stdout.write(
      "credential rotation is not yet exposed by the engine (P15 placeholder)\n",
    );
  },
});

export const credentialsCommand = defineCommand({
  meta: { name: "credentials", description: "Credential management" },
  subCommands: { list: listCmd, rotate: rotateCmd },
});
