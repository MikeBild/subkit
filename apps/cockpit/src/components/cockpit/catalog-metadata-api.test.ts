import { afterEach, describe, expect, mock, test } from "bun:test";
import { patchCatalogMetadata } from "./catalog-metadata-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("patchCatalogMetadata", () => {
  test("each kind saves through its own resource", async () => {
    const calls = capture();
    await patchCatalogMetadata("workflow", "w 1", { description: "d" });
    await patchCatalogMetadata("connector", "c", { description: "d" });
    await patchCatalogMetadata("knowledge_source", "k", { description: "d" });
    await patchCatalogMetadata("skill", "s", { description: "d" });
    await patchCatalogMetadata("file", "fid_x", { description: "d" });
    expect(calls.map((call) => new URL(call.url, "http://cockpit.test").pathname)).toEqual([
      "/v1/workflows/w%201/metadata",
      "/v1/connectors/c",
      "/v1/knowledge-sources/k",
      "/v1/skills/s",
      "/v1/files/fid_x",
    ]);
  });

  test("sends a PATCH with the JSON body", async () => {
    const calls = capture();
    await patchCatalogMetadata("file", "f", { description: "New", accept_description: true });
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ description: "New", accept_description: true }),
    );
  });
});
