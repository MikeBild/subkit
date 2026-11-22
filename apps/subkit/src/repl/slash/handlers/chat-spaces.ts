import type { PendingChatSpaceWire } from "../../../engine-client/chat.ts";
import type { SlashHandlerContext } from "../handler.ts";

export async function dispatchChatSpaceSlash(
  rawArgs: string[],
  ctx: SlashHandlerContext,
): Promise<string | null> {
  const target = (rawArgs[0] ?? "").trim();
  let pending: PendingChatSpaceWire[];
  try {
    pending = (await ctx.client.listPendingChatSpaces()).items;
  } catch (err) {
    return `couldn't list pending spaces: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!target) {
    if (pending.length === 0) {
      return "no pending chat spaces — add the app to a space and message it once, then run /install-space again (or use `subkit chat install-space` for manual/Slack installs)";
    }
    const lines = pending.map(
      (c) => `  ${c.display_name ?? c.workspace_id}  ·  ${c.platform}  ·  ${c.workspace_id}`,
    );
    return `pending chat spaces — run /install-space <id> to install one:\n${lines.join("\n")}`;
  }
  const candidate = pending.find((c) => c.workspace_id === target);
  if (!candidate) {
    return `"${target}" is not a pending space — run /install-space to list them, or use \`subkit chat install-space\` for manual/Slack installs`;
  }
  try {
    const result = await ctx.client.installChatWorkspace({
      platform: candidate.platform,
      workspace_id: candidate.workspace_id,
      installer_platform_user_id: candidate.installer_platform_user_id,
    });
    return `installed ${result.platform} space ${candidate.display_name ?? result.workspace_id} — chat there now; /new resets it`;
  } catch (err) {
    return `install failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
