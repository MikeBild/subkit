import * as prompts from "@clack/prompts";
import pc from "picocolors";
import type { EngineClient } from "../engine-client.ts";

export async function run(client: EngineClient): Promise<void> {
  prompts.intro(pc.cyan("Install Slack notifications"));
  prompts.log.info("Create a Slack incoming webhook at https://api.slack.com/apps");

  const webhookUrl = await prompts.text({
    message: "Slack webhook URL",
    placeholder: "https://hooks.slack.com/services/...",
    validate: (v) =>
      (v ?? "").startsWith("https://hooks.slack.com/") ? undefined : "Must be a Slack webhook URL",
  });
  if (prompts.isCancel(webhookUrl)) {
    prompts.cancel("Cancelled");
    return;
  }

  const name = await prompts.text({ message: "Channel display name", placeholder: "slack-alerts" });
  if (prompts.isCancel(name)) {
    prompts.cancel("Cancelled");
    return;
  }

  const spin = prompts.spinner();
  spin.start("Creating Slack notification channel...");
  try {
    const channel = await client.createNotificationChannel({
      name: String(name),
      kind: "slack",
      config: { webhook_url: String(webhookUrl) },
    });
    spin.stop("Slack channel created");
    const ch = channel as Record<string, unknown>;
    prompts.outro(
      pc.green(
        `Done! Channel "${ch.name}" (${ch.id as string}) is ready.\nUse 'sk notifications rules create' to route events to it.`,
      ),
    );
  } catch (err) {
    spin.stop("Failed");
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
