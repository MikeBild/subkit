import * as prompts from "@clack/prompts";
import pc from "picocolors";
import type { EngineClient } from "../engine-client.ts";
import { runEngineOAuthFlow } from "./oauth-flow.ts";

async function openBrowser(url: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

export async function run(client: EngineClient): Promise<void> {
  prompts.intro(pc.cyan("Install HubSpot connector"));
  prompts.log.info("This will create a HubSpot connector and start OAuth authorization.");

  const name = await prompts.text({ message: "Connector display name", placeholder: "HubSpot" });
  if (prompts.isCancel(name)) {
    prompts.cancel("Cancelled");
    return;
  }

  const spin = prompts.spinner();
  spin.start("Creating HubSpot connector...");
  let connector: Record<string, unknown>;
  try {
    const c = await client.createConnectorFromTemplate("hubspot", { name: String(name) });
    connector = c as Record<string, unknown>;
    spin.stop(`Connector "${connector.id}" created`);
  } catch (err) {
    spin.stop("Failed to create connector");
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  prompts.log.info("Opening browser for HubSpot OAuth authorization...");
  spin.start("Waiting for OAuth callback (120s timeout)...");
  try {
    await runEngineOAuthFlow(client, String(connector.id), openBrowser);
    spin.stop("OAuth authorized");
    prompts.outro(
      pc.green(
        `HubSpot connector "${connector.name}" is connected!\nUse 'sk connectors list' to verify.`,
      ),
    );
  } catch (err) {
    spin.stop("OAuth failed");
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
