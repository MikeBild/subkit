// Chat-workspace surfaces of the engine client: list/install/remove an
// external chat space, and discover the pending (added-but-not-installed)
// ones. Method group merged into `EngineClient` by `../engine-client.ts`.
//
// Mirrors apps/engine/src/http/routes/{chat-workspaces,chat-spaces}.ts.
// Kept structural (not Zod) so the CLI's tsc graph stays light.

import type { EngineClient } from "../engine-client.ts";

export type ChatPlatform = "slack" | "teams" | "google_chat";

export interface ChatWorkspaceWire {
  id: string;
  tenant_id: string;
  platform: ChatPlatform;
  workspace_id: string;
  default_channel: string | null;
  created_at: string;
  updated_at: string;
}

export interface PendingChatSpaceWire {
  platform: ChatPlatform;
  workspace_id: string;
  display_name: string | null;
  installer_platform_user_id: string;
}

export interface InstallChatWorkspaceBody {
  platform: ChatPlatform;
  workspace_id: string;
  installer_platform_user_id: string;
  /** Required for slack (per-workspace bot token); omitted for google_chat. */
  bot_token?: string;
  default_channel?: string | null;
}

export const chatMethods = {
  /** Installed chat workspaces in the caller's tenant. */
  listChatWorkspaces(this: EngineClient): Promise<{ items: ChatWorkspaceWire[] }> {
    return this.request("GET", "/v1/chat/workspaces");
  },
  /** Spaces the caller added the app to but hasn't installed yet.
   *  google_chat only today; slack/teams always return an empty list. */
  listPendingChatSpaces(
    this: EngineClient,
    query: { platform?: ChatPlatform } = {},
  ): Promise<{ items: PendingChatSpaceWire[] }> {
    return this.request("GET", "/v1/chat/spaces/pending", undefined, query);
  },
  /** Install (register) an external chat workspace/space. */
  installChatWorkspace(
    this: EngineClient,
    body: InstallChatWorkspaceBody,
  ): Promise<ChatWorkspaceWire> {
    return this.request("POST", "/v1/chat/workspaces", body);
  },
  /** Remove a chat-workspace install by row id. */
  removeChatWorkspace(this: EngineClient, id: string): Promise<{ deleted: true }> {
    return this.request("DELETE", `/v1/chat/workspaces/${encodeURIComponent(id)}`);
  },
} as const;
