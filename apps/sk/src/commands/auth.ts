// `sk auth` — MCP-parity authenticate tool as a CLI command.
//
// The MCP surface exposes reauthentication as a first-class tool so clients
// can request a portal link without knowing about /v1/connectors/:id/oauth.
// Mirror that shape from the CLI: `sk auth --connector-id X` prints the
// authorization URL the user opens in a browser to (re)approve access. The
// route is the connector's own (`sign_in` on its record): a web service and
// an MCP server sign in on different routes, and the engine says which.

import { reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
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

export const authCommand = defineCommand({
  meta: {
    name: "auth",
    description:
      "Start a connector's browser sign-in and print the URL to open. Works for every connector that signs in with an account — a web service or an MCP server; the engine names the route.",
  },
  args: {
    "connector-id": {
      type: "string",
      required: true,
      description: "Connector to reauthenticate",
    },
    json: {
      type: "boolean",
      description: "Emit the full response as JSON",
    },
  },
  async run({ args }) {
    const client = makeClient();
    const connectorId = String(args["connector-id"]);
    try {
      const res = await client.startConnectorSignIn(connectorId);

      if (args.json) {
        printJson(res);
        return;
      }

      // An empty URL: the engine finished the sign-in without a browser
      // (a client-credentials exchange) — the credential is stored.
      if (!res.authorization_url) {
        process.stdout.write("signed in — no browser step was needed\n");
        return;
      }
      process.stdout.write(`open this URL to sign in:\n  ${res.authorization_url}\n`);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});
