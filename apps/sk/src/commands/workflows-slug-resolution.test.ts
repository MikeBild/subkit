// `sk workflows run <id|slug>` previously failed with a cryptic
// `bad_request: request validation failed` when given a slug, because the
// engine's saved-run route requires a UUID workflow_id. resolveWorkflowIdOrSlug
// resolves a slug/name to the id (or throws a clear, actionable error).

import { describe, expect, test } from "bun:test";

import type { EngineClient } from "../engine-client.ts";
import { resolveWorkflowIdOrSlug } from "./workflows.ts";

const ID_A = "5a822d35-136c-43c4-9132-7a3199c909a9";
const ID_B = "84300d98-3e8d-4422-91b7-c4c94aae017b";

function fakeClient(rows: Array<{ id: string; slug?: string; name?: string }>): EngineClient {
  let called = 0;
  return {
    listWorkflows: async () => {
      called++;
      return { items: rows, total: rows.length };
    },
    get _listCalls() {
      return called;
    },
  } as unknown as EngineClient;
}

describe("resolveWorkflowIdOrSlug", () => {
  const rows = [
    { id: ID_A, slug: "get-last-3-gmail-messages", name: "Get Last 3 Gmail Messages" },
    { id: ID_B, slug: "berlin-weather-tomorrow", name: "Berlin Weather Tomorrow" },
  ];

  test("a UUID passes through untouched (no lookup)", async () => {
    // A bogus client whose listWorkflows would throw — proving the UUID path
    // never calls it.
    const client = {
      listWorkflows: async () => {
        throw new Error("should not be called for a UUID");
      },
    } as unknown as EngineClient;
    expect(await resolveWorkflowIdOrSlug(client, ID_A)).toBe(ID_A);
  });

  test("a slug resolves to its workflow id", async () => {
    expect(await resolveWorkflowIdOrSlug(fakeClient(rows), "berlin-weather-tomorrow")).toBe(ID_B);
  });

  test("an exact name resolves to its workflow id", async () => {
    expect(await resolveWorkflowIdOrSlug(fakeClient(rows), "Get Last 3 Gmail Messages")).toBe(ID_A);
  });

  test("an unknown slug throws a clear, actionable error", async () => {
    await expect(resolveWorkflowIdOrSlug(fakeClient(rows), "no-such-wf")).rejects.toThrow(
      /no workflow found with id or slug 'no-such-wf'/,
    );
  });

  test("an ambiguous match throws rather than guessing", async () => {
    const dupes = [
      { id: ID_A, slug: "dup", name: "A" },
      { id: ID_B, slug: "dup", name: "B" },
    ];
    await expect(resolveWorkflowIdOrSlug(fakeClient(dupes), "dup")).rejects.toThrow(/ambiguous/);
  });
});
