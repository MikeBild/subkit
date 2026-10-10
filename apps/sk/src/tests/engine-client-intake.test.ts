import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

function clientCapturing(captured: Captured[]): EngineClient {
  return new EngineClient({
    engine_url: "https://engine.test",
    api_key: "k-123",
    fetchImpl: async (url, init) => {
      const target = new URL(String(url));
      captured.push({
        method: init?.method ?? "GET",
        path: `${target.pathname}${target.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ items: [], total: 0, category: "inbox" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
}

describe("engine-client intake methods", () => {
  test("reads the personal default and only collected items in a shared category", async () => {
    const captured: Captured[] = [];
    const client = clientCapturing(captured);
    await client.getDefaultIntakeCategory();
    await client.setDefaultIntakeCategory("research");
    await client.listIntakeItems({ category: "research", state: "collected" });
    await client.getIntakeItem("item-1");
    await client.patchIntakeItem("item-1", { category: "research", expected_version: 3 });
    expect(captured).toEqual([
      { method: "GET", path: "/v1/intake/default-category", body: undefined },
      { method: "PATCH", path: "/v1/intake/default-category", body: { category: "research" } },
      {
        method: "GET",
        path: "/v1/intake/items?category=research&state=collected",
        body: undefined,
      },
      { method: "GET", path: "/v1/intake/items/item-1", body: undefined },
      {
        method: "PATCH",
        path: "/v1/intake/items/item-1",
        body: { category: "research", expected_version: 3 },
      },
    ]);
  });

  test("sends a structured intake selection only when opening the conversation", async () => {
    const captured: Captured[] = [];
    const client = clientCapturing(captured);
    await client.createConversation({
      initial_message: "Review selected items.",
      intake_item_ids: ["10000000-0000-4000-8000-000000000001"],
    });
    expect(captured[0]).toEqual({
      method: "POST",
      path: "/v1/conversations",
      body: {
        initial_message: "Review selected items.",
        intake_item_ids: ["10000000-0000-4000-8000-000000000001"],
      },
    });
  });
});
