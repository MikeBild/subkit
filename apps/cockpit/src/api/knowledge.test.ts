import { afterEach, expect, spyOn, test } from "bun:test";
import { loadKnowledgeChunks } from "./knowledge";

const fetchPreconnect = globalThis.fetch.preconnect;

function fetchWithPreconnect(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetchPreconnect });
}

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

test("loads the whole document beyond the first chunk page", async () => {
  const offsets: string[] = [];
  mocks.push(
    spyOn(globalThis, "fetch").mockImplementation(
      fetchWithPreconnect(async (input) => {
        const offset =
          new URL(String(input), "https://example.com").searchParams.get("offset") ?? "0";
        offsets.push(offset);
        return Response.json({
          knowledge_source_id: "source",
          name: "Document",
          chunk_count: 201,
          items: Array.from({ length: offset === "0" ? 200 : 1 }, (_, index) => ({
            ordinal: Number(offset) + index,
            title: "Document",
            path: "/document",
            content: `part${Number(offset) + index}`,
            byte_size: 1,
          })),
        });
      }),
    ),
  );
  const result = await loadKnowledgeChunks("source");
  expect(offsets).toEqual(["0", "200"]);
  expect(result.items).toHaveLength(201);
  expect(result.items.at(-1)?.content).toBe("part200");
});

test("refuses an incomplete snapshot when the source changes between pages", async () => {
  let page = 0;
  mocks.push(
    spyOn(globalThis, "fetch").mockImplementation(
      fetchWithPreconnect(async () =>
        Response.json(
          ++page === 1
            ? { chunk_count: 2, items: [{ ordinal: 0 }] }
            : { chunk_count: 1, items: [] },
        ),
      ),
    ),
  );
  await expect(loadKnowledgeChunks("source")).rejects.toThrow("knowledge-chunks-changed");
});

test("pages by the contract's chunk_count and ignores a stray total", async () => {
  const urls: string[] = [];
  mocks.push(
    spyOn(globalThis, "fetch").mockImplementation(
      fetchWithPreconnect(async (input) => {
        urls.push(String(input));
        const offset =
          new URL(String(input), "https://example.com").searchParams.get("offset") ?? "0";
        return Response.json({
          knowledge_source_id: "source",
          name: "Document",
          chunk_count: 2,
          total: 1,
          items: [{ ordinal: Number(offset), title: null, path: null, content: "x", byte_size: 1 }],
        });
      }),
    ),
  );
  const result = await loadKnowledgeChunks("source");
  expect(result.items).toHaveLength(2);
  expect(urls.map((url) => new URL(url, "https://example.com").search)).toEqual([
    "?limit=200",
    "?limit=200&offset=1",
  ]);
});
