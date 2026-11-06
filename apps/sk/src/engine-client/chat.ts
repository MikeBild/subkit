import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export type ChatPlatform = "slack" | "teams" | "google_chat";

interface ChatWorkspaceWire {
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
  async listChatWorkspaces(this: EngineClient): Promise<{ items: ChatWorkspaceWire[] }> {
    const { data } = await this.api.GET("/v1/chat/workspaces");
    return data as { items: ChatWorkspaceWire[] };
  },
  async listPendingChatSpaces(
    this: EngineClient,
    query: { platform?: ChatPlatform } = {},
  ): Promise<{ items: PendingChatSpaceWire[] }> {
    const { data } = await this.api.GET("/v1/chat/spaces/pending", {
      params: { query: query as ApiQuery<"/v1/chat/spaces/pending", "get"> },
    });
    return data as { items: PendingChatSpaceWire[] };
  },
  async installChatWorkspace(
    this: EngineClient,
    body: InstallChatWorkspaceBody,
  ): Promise<ChatWorkspaceWire> {
    const { data } = await this.api.POST("/v1/chat/workspaces", {
      body: body as ApiBody<"/v1/chat/workspaces", "post">,
    });
    return data as ChatWorkspaceWire;
  },
  async removeChatWorkspace(this: EngineClient, id: string): Promise<{ deleted: true }> {
    const { data } = await this.api.DELETE("/v1/chat/workspaces/{id}", {
      params: { path: { id } },
    });
    return data as { deleted: true };
  },
} as const;
