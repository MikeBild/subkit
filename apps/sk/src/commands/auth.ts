// `sk auth` — MCP-parity authenticate tool as a CLI command.
//
// Superglue exposes reauthentication as a first-class MCP tool so clients
// can request a portal link without knowing about /v1/connectors/:id/oauth.
// Mirror that shape from the CLI: `sk auth --connector-id X` prints the
// authorization URL the user opens in a browser to (re)approve access.

import { exitCodeFor } from "@cli-core/errors";
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
    description: "Start a reauthentication flow for a connector (OAuth2 authorize URL)",
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
      // Reuse the existing /v1/connectors/:id/oauth/start endpoint — the
      // MCP `authenticate` tool wraps the same flow internally, so the
      // CLI surface stays simple while the MCP surface exposes it to
      // agents.
      const res = await client.request<{
        authorization_url?: string;
        state?: string;
      }>("POST", `/v1/connectors/${encodeURIComponent(connectorId)}/oauth/start`);

      if (args.json) {
        printJson(res);
        return;
      }

      const url = res.authorization_url;
      if (!url) {
        process.stderr.write("no authorization_url in response\n");
        process.exit(1);
      }
      process.stdout.write(`${url}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});
