import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";

const WORKFLOW = "3fb5fc90-1c2d-4e5f-8a6b-7c8d9e0f1a2b";

function engineWith(total: number, serverPageCap = 200) {
  const requests: Array<{ limit: number; offset: number }> = [];
  const client = new EngineClient({
    engine_url: "https://engine.example.com",
    api_key: "placeholder-key",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), serverPageCap);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      requests.push({ limit, offset });
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => ({
          id: `version-${total - offset - i}`,
          version: total - offset - i,
          note: null,
          created_at: "2030-01-01T00:00:00.000Z",
          invalid: false,
        }),
      );
      return new Response(JSON.stringify({ items, total }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

describe("listWorkflowVersions", () => {
  test("a history longer than one page is read in full, newest first", async () => {
    const { client, requests } = engineWith(450);
    const { items, total } = await client.listWorkflowVersions(WORKFLOW);
    expect(total).toBe(450);
    expect(items).toHaveLength(450);
    expect(items[0]?.version).toBe(450);
    expect(items.at(-1)?.version).toBe(1);
    expect(new Set(items.map((item) => item.version)).size).toBe(450);
    expect(requests).toEqual([
      { limit: 200, offset: 0 },
      { limit: 200, offset: 200 },
      { limit: 200, offset: 400 },
    ]);
  });

  test("a short history is one request", async () => {
    const { client, requests } = engineWith(3);
    expect((await client.listWorkflowVersions(WORKFLOW)).items.map((v) => v.version)).toEqual([
      3, 2, 1,
    ]);
    expect(requests).toHaveLength(1);
  });

  test("an empty history ends the loop", async () => {
    const { client, requests } = engineWith(0);
    expect(await client.listWorkflowVersions(WORKFLOW)).toEqual({ items: [], total: 0 });
    expect(requests).toHaveLength(1);
  });

  test("a history that shrinks while it is read still ends", async () => {
    const client = new EngineClient({
      engine_url: "https://engine.example.com",
      api_key: "placeholder-key",
      fetchImpl: async (input) => {
        const offset = Number(new URL(String(input)).searchParams.get("offset") ?? 0);
        const items =
          offset === 0
            ? [
                {
                  id: "v2",
                  version: 2,
                  note: null,
                  created_at: "2030-01-01T00:00:00.000Z",
                  invalid: false,
                },
              ]
            : [];
        return new Response(JSON.stringify({ items, total: 5 }), { status: 200 });
      },
    });
    expect((await client.listWorkflowVersions(WORKFLOW)).items).toHaveLength(1);
  });
});
