// The `sk chat` engine-client method group must hit the exact routes
// the engine exposes, with the Bearer header attached. A drift here
// silently 404s the CLI while typechecking fine (paths are strings).

import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";

interface Captured {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

function clientCapturing(captured: Captured[], responseBody: unknown = {}) {
  return new EngineClient({
    engine_url: "https://engine.test",
    api_key: "k-123",
    tenant: null,
    fetchImpl: async (url, init) => {
      const u = new URL(String(url));
      captured.push({
        method: init?.method ?? "GET",
        path: u.pathname + u.search,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

describe("engine-client chat methods", () => {
  test("listChatWorkspaces → GET /v1/chat/workspaces with Bearer", async () => {
    const cap: Captured[] = [];
    await clientCapturing(cap, { items: [] }).listChatWorkspaces();
    expect(cap[0]).toMatchObject({
      method: "GET",
      path: "/v1/chat/workspaces",
      auth: "Bearer k-123",
    });
  });

  test("listPendingChatSpaces passes the platform query", async () => {
    const cap: Captured[] = [];
    await clientCapturing(cap, { items: [] }).listPendingChatSpaces({ platform: "google_chat" });
    expect(cap[0]?.method).toBe("GET");
    expect(cap[0]?.path).toBe("/v1/chat/spaces/pending?platform=google_chat");
  });

  test("installChatWorkspace → POST /v1/chat/workspaces with the body", async () => {
    const cap: Captured[] = [];
    await clientCapturing(cap, { id: "w1" }).installChatWorkspace({
      platform: "google_chat",
      workspace_id: "spaces/X",
      installer_platform_user_id: "users/1",
    });
    expect(cap[0]).toMatchObject({ method: "POST", path: "/v1/chat/workspaces" });
    expect(cap[0]?.body).toEqual({
      platform: "google_chat",
      workspace_id: "spaces/X",
      installer_platform_user_id: "users/1",
    });
  });

  test("removeChatWorkspace → DELETE /v1/chat/workspaces/{id} (encoded)", async () => {
    const cap: Captured[] = [];
    await clientCapturing(cap, { deleted: true }).removeChatWorkspace("a/b");
    expect(cap[0]).toMatchObject({ method: "DELETE", path: "/v1/chat/workspaces/a%2Fb" });
  });
});
