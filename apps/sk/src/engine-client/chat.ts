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
  bot_token?: string;
  default_channel?: string | null;
}

export const chatMethods = {
  listChatWorkspaces(this: EngineClient): Promise<{ items: ChatWorkspaceWire[] }> {
    return this.request("GET", "/v1/chat/workspaces");
  },
  listPendingChatSpaces(
    this: EngineClient,
    query: { platform?: ChatPlatform } = {},
  ): Promise<{ items: PendingChatSpaceWire[] }> {
    return this.request("GET", "/v1/chat/spaces/pending", undefined, query);
  },
  installChatWorkspace(
    this: EngineClient,
    body: InstallChatWorkspaceBody,
  ): Promise<ChatWorkspaceWire> {
    return this.request("POST", "/v1/chat/workspaces", body);
  },
  removeChatWorkspace(this: EngineClient, id: string): Promise<{ deleted: true }> {
    return this.request("DELETE", `/v1/chat/workspaces/${encodeURIComponent(id)}`);
  },
} as const;
