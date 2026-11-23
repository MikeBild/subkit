import { expect, test } from "bun:test";
import {
  type Attention,
  attentionBadge,
  entrySnapshot,
  overviewSections,
} from "./attention-projection";
import { item } from "./overview-model-fixtures";

test("snapshot records the primary action even after a secondary action", () => {
  const entry = item({
    actions: [
      { verb: "chat", href: "/chat", primary: false, permission: "conversation:write" },
      { verb: "review", href: "/review", primary: true, permission: "workflow:write" },
    ],
  });
  expect(JSON.parse(entrySnapshot(entry))).toEqual([
    entry.reason,
    entry.class,
    entry.counts,
    "review",
  ]);
});

test("nothing readable does not gain an unread section", () => {
  expect(
    overviewSections({ kind: "nothing_readable" }, { operations: false, history: false }),
  ).toEqual([]);
});

test("a mixed attention list is stopped when any entry is stopped", () => {
  const attention: Attention = {
    schema_version: "attention.v1",
    generated_at: "2026-01-01T00:00:00Z",
    status: null,
    sources: {
      conversations: "answered",
      schedules: "answered",
      freshness: "answered",
      failures: "answered",
      patches: "answered",
      connectors: "answered",
      connections: "answered",
      secret_approvals: "answered",
      skills: "answered",
      intake: "answered",
      budget: "answered",
      ai_access: "answered",
      risk: "answered",
      tasks: "answered",
    },
    items: [
      item({ id: "stop", subject: null, class: "stopped" }),
      item({ id: "decide", subject: null, class: "decide" }),
    ],
    snoozed: [],
  };
  expect(attentionBadge(attention)).toEqual({ count: 2, stopped: true });
});
