import { expect, test } from "bun:test";
import { type ApiError, KnowledgeApi } from "./api.ts";

test("create-only bundle requests preserve a slug conflict identifier", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  Object.assign(globalThis, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify({
          code: "slug_exists",
          details: { knowledge_source_id: "source-id" },
          message: "already exists",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    await expect(
      new KnowledgeApi("https://engine.example", "key").createBundle(
        "Clips",
        "clips-one",
        "/clips/a.md",
        "content",
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "slug_exists",
      details: { knowledge_source_id: "source-id" },
    } satisfies Partial<ApiError>);
    expect(await request?.json()).toEqual({
      name: "Clips",
      slug: "clips-one",
      scope: "global",
      create_only: true,
      files: [{ path: "/clips/a.md", content: "content" }],
    });
  } finally {
    Object.assign(globalThis, { fetch: originalFetch });
  }
});
