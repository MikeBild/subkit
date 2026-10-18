import { describe, expect, test } from "bun:test";
import {
  cleanupSessionLearningFixtures,
  proposalCitesOnly,
  sessionLearningFixture,
  targetReachesDomain,
} from "./cockpit-session-learning-journey.mjs";

describe("session learning review journey", () => {
  test("keeps fixtures in a dedicated category instead of the personal default", () => {
    const fixture = sessionLearningFixture("0a1b2c3d");
    expect(fixture.category).toBe("journey-0a1b2c3d");
    expect(fixture.category).not.toBe("inbox");
    expect(fixture.skillTitle).toContain(fixture.label);
    expect(() => sessionLearningFixture("../inbox")).toThrow();
  });

  test("accepts a model target only when it reaches the fixture domain", () => {
    const domain = "journey-0a1b2c3d";
    expect(
      targetReachesDomain(
        { name: `Knowledge · ${domain}`, category: domain, tags: [`domain:${domain}`] },
        domain,
      ),
    ).toBe(true);
    expect(targetReachesDomain({ name: "Invented bundle", category: domain }, domain)).toBe(false);
    expect(
      targetReachesDomain(
        { skill: { new: { title: "t", scope: "global", tags: [`domain:${domain}`] } } },
        domain,
      ),
    ).toBe(true);
    expect(
      targetReachesDomain({ skill: { new: { title: "t", scope: "global", tags: [] } } }, domain),
    ).toBe(false);
    expect(targetReachesDomain({ knowledge_source_id: "k", expected_version: "v" }, domain)).toBe(
      true,
    );
  });

  test("accepts a proposal only when every cited item is a fixture", () => {
    const proposal = (ids: string[]) => ({ revision: { items: ids.map((id) => ({ id })) } });
    expect(proposalCitesOnly(proposal(["a", "b"]), ["a", "b", "c"])).toBe(true);
    expect(proposalCitesOnly(proposal(["a", "foreign"]), ["a", "b"])).toBe(false);
    expect(proposalCitesOnly(proposal([]), ["a"])).toBe(false);
  });

  test("cleans exactly the recorded fixtures and reports what intake retains", async () => {
    const calls: string[] = [];
    const records: Record<string, Record<string, unknown>> = {
      "/v1/intake/proposals/draft": { status: "draft", current_revision: 2 },
      "/v1/intake/proposals/confirmed": { status: "confirmed", current_revision: 1 },
      "/v1/intake/items/collected": { state: "collected", version: 3 },
      "/v1/intake/items/admitted": { state: "admitted", version: 1 },
    };
    const cleanup = await cleanupSessionLearningFixtures(
      {
        conversationIds: ["chat"],
        proposalIds: ["draft", "confirmed"],
        skillIds: ["created", "broken"],
        itemIds: ["collected", "admitted"],
      },
      {
        read: async (path: string) => {
          calls.push(`GET ${path}`);
          const record = records[path];
          if (!record) throw new Error("missing");
          return record;
        },
        write: async (path: string, method: string, data: unknown) => {
          calls.push(`${method} ${path} ${JSON.stringify(data)}`);
          return {};
        },
        remove: async (path: string) => {
          calls.push(`DELETE ${path}`);
          if (path.endsWith("/broken")) throw new Error("HTTP 500");
          return {};
        },
      },
    );
    expect(calls).toEqual([
      "DELETE /v1/conversations/chat",
      "GET /v1/intake/proposals/draft",
      'POST /v1/intake/proposals/draft/reject {"expected_revision":2}',
      "GET /v1/intake/proposals/confirmed",
      "DELETE /v1/skills/created",
      "DELETE /v1/skills/broken",
      "GET /v1/intake/items/collected",
      'PATCH /v1/intake/items/collected {"state":"discarded","expected_version":3}',
      "GET /v1/intake/items/admitted",
    ]);
    expect(cleanup).toEqual({
      deleted: ["chat", "created"],
      discarded: ["collected"],
      rejected: ["draft"],
      retained: ["confirmed", "admitted"],
      failures: ["skill broken: HTTP 500"],
    });
  });
});
