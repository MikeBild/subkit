import * as prompts from "@clack/prompts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import pc from "picocolors";
import type { EngineClient } from "../engine-client.ts";

type CreateChannelBody = components["schemas"]["CreateNotificationChannelBody"];
type ChatWorkspace = components["schemas"]["ChatWorkspace"];

export function slackChannelBody(workspaceId: string, channelId: string): CreateChannelBody {
  return {
    platform: "slack",
    workspace_id: workspaceId,
    channel_id: channelId.trim(),
  } satisfies CreateChannelBody;
}

async function pickWorkspace(workspaces: ChatWorkspace[]): Promise<ChatWorkspace | symbol> {
  const [only] = workspaces;
  if (workspaces.length === 1 && only) return only;
  return prompts.select<ChatWorkspace>({
    message: "Slack workspace",
    options: workspaces.map((w) => ({ value: w, label: w.workspace_id })),
  });
}

export async function run(client: EngineClient): Promise<void> {
  prompts.intro(pc.cyan("Install Slack notifications"));

  let workspaces: ChatWorkspace[];
  try {
    const { data } = await client.api.GET("/v1/chat/workspaces");
    workspaces = (data?.items ?? []).filter((w) => w.platform === "slack");
  } catch (err) {
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }
  if (workspaces.length === 0) {
    prompts.log.error(
      "No Slack workspace installed. Install the Slack app first: subkit chat install-space slack <workspace_id> --as <your-slack-user-id> --bot-token xoxb-…",
    );
    process.exit(1);
    return;
  }

  const workspace = await pickWorkspace(workspaces);
  if (typeof workspace === "symbol") {
    prompts.cancel("Cancelled");
    return;
  }

  const channelId = await prompts.text({
    message: "Slack channel id",
    placeholder: "C0123456",
    ...(workspace.default_channel ? { initialValue: workspace.default_channel } : {}),
    validate: (v) => ((v ?? "").trim() ? undefined : "Enter the Slack channel id (C…)"),
  });
  if (prompts.isCancel(channelId)) {
    prompts.cancel("Cancelled");
    return;
  }

  const spin = prompts.spinner();
  spin.start("Creating Slack notification channel...");
  try {
    const { data: channel } = await client.api.POST("/v1/notifications/channels", {
      body: slackChannelBody(workspace.workspace_id, String(channelId)),
    });
    if (!channel) throw new Error("engine returned no notification channel");
    spin.stop("Slack channel created");
    prompts.outro(
      pc.green(
        `Done! Channel "${channel.channel_id}" (${channel.id}) is ready.\nUse 'subkit notifications rules create' to route events to it.`,
      ),
    );
  } catch (err) {
    spin.stop("Failed");
    prompts.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
