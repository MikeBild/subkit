import * as prompts from "@clack/prompts";
import pc from "picocolors";
import type { EngineClient } from "../engine-client.ts";

export async function run(client: EngineClient): Promise<void> {
  prompts.intro(pc.cyan("Install Microsoft Teams notifications"));
  prompts.log.info("Create an incoming webhook in your Teams channel settings");

  const webhookUrl = await prompts.text({
    message: "Teams webhook URL",
    placeholder: "https://outlook.office.com/webhook/...",
    validate: (v) => ((v ?? "").startsWith("https://") ? undefined : "Must be an HTTPS URL"),
  });
  if (prompts.isCancel(webhookUrl)) {
    prompts.cancel("Cancelled");
    return;
  }

  const name = await prompts.text({ message: "Channel display name", placeholder: "teams-alerts" });
  if (prompts.isCancel(name)) {
    prompts.cancel("Cancelled");
    return;
  }

  const spin = prompts.spinner();
  spin.start("Creating Teams notification channel...");
  try {
    const channel = await client.createNotificationChannel({
      name: String(name),
      kind: "teams",
      config: { webhook_url: String(webhookUrl) },
    });
    spin.stop("Teams channel created");
    const ch = channel as Record<string, unknown>;
    prompts.outro(pc.green(`Done! Channel "${ch.name}" (${ch.id as string}) is ready.`));
  } catch (err) {
    spin.stop("Failed");
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
