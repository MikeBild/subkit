import { describe, expect, test } from "bun:test";
import { conversationAttentionItem } from "./conversation-item.ts";

const CONVERSATION = {
  id: "c1",
  title: "Papier nachbestellen",
  updated_at: new Date("2026-11-21T09:00:00.000Z"),
};
const ASKED = new Date("2026-11-21T09:10:00.000Z");
const DEADLINE = new Date("2026-11-21T09:25:00.000Z");

describe("an open conversation in the attention list", () => {
  test("a question waits for an answer", () => {
    expect(
      conversationAttentionItem(
        CONVERSATION,
        { created_at: ASKED, expires_at: DEADLINE, local: false },
        "/c/c1",
      ),
    ).toEqual({
      id: "conversation:c1",
      class: "stopped",
      severity: "urgent",
      kind: "conversation",
      subject: { kind: "conversation", id: "c1", name: "Papier nachbestellen" },
      reason: "awaiting_answer",
      trigger: null,
      cause_class: null,
      counts: {},
      since: "2026-11-21T09:10:00.000Z",
      deadline: "2026-11-21T09:25:00.000Z",
      detail: null,
      actions: [{ verb: "answer", href: "/c/c1", primary: true, permission: "conversation:write" }],
    });
  });

  test("a local step waits for its owner to confirm, with the step's deadline", () => {
    expect(
      conversationAttentionItem(
        CONVERSATION,
        { created_at: ASKED, expires_at: DEADLINE, local: true },
        "/c/c1",
      ),
    ).toMatchObject({
      class: "decide",
      kind: "local_confirmation",
      reason: "local_confirmation_needed",
      deadline: "2026-11-21T09:25:00.000Z",
      actions: [{ verb: "answer", href: "/c/c1", primary: true, permission: "local:confirm" }],
    });
  });

  test("without an open question it dates from the last change and has no deadline", () => {
    expect(conversationAttentionItem(CONVERSATION, undefined, "/c/c1")).toMatchObject({
      class: "stopped",
      reason: "awaiting_answer",
      since: "2026-11-21T09:00:00.000Z",
      deadline: null,
    });
  });
});
