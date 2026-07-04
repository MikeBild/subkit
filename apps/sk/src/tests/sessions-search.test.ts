// `sk sessions search` — pure fuzzy-ranking logic over cached metadata.

import { describe, expect, test } from "bun:test";
import { rankSessions } from "../commands/sessions.ts";

const ROWS = [
  {
    conversation_id: "11111111-aaaa-bbbb-cccc-dddddddddddd",
    alias: "jira-sync",
    title: "Sync Jira tickets to Notion",
    last_used_at: "2026-06-01T10:00:00.000Z",
  },
  {
    conversation_id: "22222222-aaaa-bbbb-cccc-dddddddddddd",
    alias: "gh-report",
    title: "GitHub weekly report",
    last_used_at: "2026-06-02T10:00:00.000Z",
  },
  {
    conversation_id: "33333333-aaaa-bbbb-cccc-dddddddddddd",
    alias: null,
    title: "Stripe invoice digest",
    last_used_at: "2026-06-03T10:00:00.000Z",
  },
];

describe("rankSessions", () => {
  test("title match finds the session", () => {
    const out = rankSessions(ROWS, "jira", 10);
    expect(out[0]?.alias).toBe("jira-sync");
  });

  test("alias match works with a typo", () => {
    const out = rankSessions(ROWS, "gh-reprt", 10);
    expect(out.some((r) => r.alias === "gh-report")).toBe(true);
  });

  test("id prefix matches", () => {
    const out = rankSessions(ROWS, "33333333", 10);
    expect(out.some((r) => r.title === "Stripe invoice digest")).toBe(true);
  });

  test("limit caps results and nonsense yields empty", () => {
    expect(rankSessions(ROWS, "report", 1).length).toBeLessThanOrEqual(1);
    expect(rankSessions(ROWS, "zzzzyyyyxxxx", 10)).toEqual([]);
  });
});
