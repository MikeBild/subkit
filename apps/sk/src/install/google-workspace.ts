import type { EngineClient } from "../engine-client.ts";
import { runConnectorWizard } from "./connector-wizard.ts";

export function run(client: EngineClient): Promise<void> {
  return runConnectorWizard(client, { slug: "google-workspace", label: "Google Workspace" });
}
