import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { withCommandErrors } from "./command-runtime.ts";

function makeWizardCommand(name: string, description: string, wizardModule: string) {
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
        const mod = await import(wizardModule);
        await mod.run(client);
      });
    },
  });
}

export const installCommand = defineCommand({
  meta: { name: "install", description: "Guided setup for enterprise integrations" },
  subCommands: {
    slack: makeWizardCommand("slack", "Install Slack notifications", "../install/slack.ts"),
    teams: makeWizardCommand(
      "teams",
      "Install Microsoft Teams notifications",
      "../install/teams.ts",
    ),
    github: makeWizardCommand("github", "Install GitHub connector", "../install/github.ts"),
    "google-workspace": makeWizardCommand(
      "google-workspace",
      "Install Google Workspace connector",
      "../install/google-workspace.ts",
    ),
    salesforce: makeWizardCommand(
      "salesforce",
      "Install Salesforce connector",
      "../install/salesforce.ts",
    ),
    jira: makeWizardCommand("jira", "Install Jira connector", "../install/jira.ts"),
    hubspot: makeWizardCommand("hubspot", "Install HubSpot connector", "../install/hubspot.ts"),
  },
});
