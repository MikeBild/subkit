import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { listProposedSkillCandidates } from "./decisions";

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

describe("source proposal pagination", () => {
  test("retains the source filter on every page and exposes later reviewable proposals", async () => {
    const paths: URL[] = [];
    mocks.push(
      spyOn(globalThis, "fetch").mockImplementation(
        fetchWithPreconnect(async (input) => {
          const path = new URL(String(input), "https://example.com");
          paths.push(path);
          const later = path.searchParams.has("offset");
          return Response.json({
            items: later
              ? [{ id: "reviewable", reviewable: true, review_digest: "digest" }]
              : Array.from({ length: 200 }, (_, index) => ({
                  id: String(index),
                  reviewable: false,
                })),
            total: 201,
            reviewable_total: 1,
          });
        }),
      ),
    );
    const result = await listProposedSkillCandidates("source-id");
    expect(paths).toHaveLength(2);
    expect(
      paths.every((path) => path.searchParams.get("knowledge_source_id") === "source-id"),
    ).toBe(true);
    expect(paths[1]?.searchParams.get("offset")).toBe("200");
    expect(result.items).toHaveLength(201);
    expect(result.items.find((item) => item.reviewable)?.id).toBe("reviewable");
    expect(result.reviewable_total).toBe(1);
  });

  test("the general proposal list keeps its unscoped contract", async () => {
    let request = "";
    mocks.push(
      spyOn(globalThis, "fetch").mockImplementation(
        fetchWithPreconnect(async (input) => {
          request = String(input);
          return Response.json({ items: [], total: 0, reviewable_total: 0 });
        }),
      ),
    );
    await listProposedSkillCandidates();
    expect(request).not.toContain("knowledge_source_id");
  });
});
