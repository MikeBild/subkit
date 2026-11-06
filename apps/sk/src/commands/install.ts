import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { withCommandErrors } from "./command-runtime.ts";

type Wizard = { run(client: EngineClient): Promise<void> };

const WIZARDS = {
  slack: () => import("../install/slack.ts"),
  github: () => import("../install/github.ts"),
  "google-workspace": () => import("../install/google-workspace.ts"),
  salesforce: () => import("../install/salesforce.ts"),
  jira: () => import("../install/jira.ts"),
  hubspot: () => import("../install/hubspot.ts"),
} satisfies Record<string, () => Promise<Wizard>>;

function makeWizardCommand(name: keyof typeof WIZARDS, description: string) {
  return defineCommand({
    meta: { name, description },
    async run() {
      const profile = resolveProfile();
      const client = new EngineClient({
        engine_url: profile.engine_url,
        api_key: profile.api_key,
        tenant: profile.active_tenant_id,
      });
      return withCommandErrors(async () => {
        const mod = await WIZARDS[name]();
        await mod.run(client);
      });
    },
  });
}

export const installCommand = defineCommand({
  meta: { name: "install", description: "Guided setup for enterprise integrations" },
  subCommands: {
    slack: makeWizardCommand("slack", "Install Slack notifications"),
    github: makeWizardCommand("github", "Install GitHub connector"),
    "google-workspace": makeWizardCommand("google-workspace", "Install Google Workspace connector"),
    salesforce: makeWizardCommand("salesforce", "Install Salesforce connector"),
    jira: makeWizardCommand("jira", "Install Jira connector"),
    hubspot: makeWizardCommand("hubspot", "Install HubSpot connector"),
  },
});
