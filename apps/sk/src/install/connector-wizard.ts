import * as prompts from "@clack/prompts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import pc from "picocolors";
import type { EngineClient } from "../engine-client.ts";
import { runEngineOAuthFlow } from "./oauth-flow.ts";

type FromTemplateBody = components["schemas"]["ConnectorFromTemplateBody"];

export interface ConnectorWizardSpec {
  slug: string;
  label: string;
}

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

export function fromTemplateBody(name: unknown): FromTemplateBody {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return (trimmed ? { name: trimmed } : {}) satisfies FromTemplateBody;
}

export async function runConnectorWizard(
  client: EngineClient,
  spec: ConnectorWizardSpec,
): Promise<void> {
  const { slug, label } = spec;
  prompts.intro(pc.cyan(`Install ${label} connector`));
  prompts.log.info(`This will create a ${label} connector and start OAuth authorization.`);

  const name = await prompts.text({ message: "Connector display name", placeholder: label });
  if (prompts.isCancel(name)) {
    prompts.cancel("Cancelled");
    return;
  }

  const spin = prompts.spinner();
  spin.start(`Creating ${label} connector...`);
  let connector: { id: string; display_name: string };
  try {
    const { data } = await client.api.POST("/v1/connectors/from-template/{slug}", {
      params: { path: { slug } },
      body: fromTemplateBody(name),
    });
    if (!data) throw new Error(`engine returned no connector for template '${slug}'`);
    connector = data;
    spin.stop(`Connector "${connector.id}" created`);
  } catch (err) {
    spin.stop("Failed to create connector");
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  prompts.log.info(`Opening browser for ${label} OAuth authorization...`);
  spin.start("Waiting for OAuth callback (120s timeout)...");
  try {
    await runEngineOAuthFlow(client, connector.id, openBrowser);
    spin.stop("OAuth authorized");
    prompts.outro(
      pc.green(
        `${label} connector "${connector.display_name}" is connected!\nUse 'sk connectors list' to verify.`,
      ),
    );
  } catch (err) {
    spin.stop("OAuth failed");
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
