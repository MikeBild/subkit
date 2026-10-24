import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { approveSkillCandidates, listProposedSkillCandidates } from "./decisions";

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

describe("proposal pagination", () => {
  test("pages through every proposal and exposes later reviewable proposals", async () => {
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
    const result = await listProposedSkillCandidates();
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.searchParams.get("status") === "proposed")).toBe(true);
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

describe("approving skill candidates together", () => {
  test("sends every chosen candidate with the digest that was reviewed in one request", async () => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    mocks.push(
      spyOn(globalThis, "fetch").mockImplementation(
        fetchWithPreconnect(async (input, init) => {
          calls.push({
            url: String(input),
            method: init?.method,
            body: JSON.parse(String(init?.body ?? "null")),
          });
          return Response.json({ results: [], approved: 0 });
        }),
      ),
    );
    await approveSkillCandidates([
      { id: "a", expected_review_digest: "1" },
      { id: "b", expected_review_digest: "2" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toEndWith("/v1/skill-candidates/approve");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      candidates: [
        { id: "a", expected_review_digest: "1" },
        { id: "b", expected_review_digest: "2" },
      ],
    });
  });
});
