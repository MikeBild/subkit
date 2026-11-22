import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

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
    return withCommandErrors(
      async () => {
        const res = await client.startConnectorSignIn(connectorId);

        if (args.json) {
          printJson(res);
          return;
        }

        if (!res.authorization_url) {
          process.stdout.write("signed in — no browser step was needed\n");
          return;
        }
        process.stdout.write(`open this URL to sign in:\n  ${res.authorization_url}\n`);
      },
      { json: Boolean(args.json) },
    );
  },
});
