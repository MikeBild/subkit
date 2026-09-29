import { describe, expect, test } from "bun:test";
import { referencesFromPart } from "./chat-references";
import {
  budgetPill,
  chatHeaderTitle,
  conversationOpenedByFailedSend,
  costPill,
  nextSessionKey,
  type OptimisticMessage,
  optimisticUiMessage,
  optimisticVisible,
  recoverFailedSend,
  shouldRestoreComposer,
  tokenPill,
} from "./chat-session";

const user = { role: "user" };
const assistant = { role: "assistant" };

function pending(overrides: Partial<OptimisticMessage> = {}): OptimisticMessage {
  return {
    session: 3,
    text: "Zeig mir die Workflows in @kategorie/notion",
    references: [],
    baseline: 1,
    sentAt: "2026-09-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("session key", () => {
  test("the first send rewriting /chat/new to /chat/<id> keeps the key: nothing remounts", () => {
    expect(nextSessionKey(3, "firstSendSaved")).toBe(3);
  });

  test("a deliberate move starts a new session", () => {
    for (const navigation of ["startNew", "select", "popstate"] as const)
      expect(nextSessionKey(3, navigation), navigation).toBe(4);
  });
});

describe("the request just sent", () => {
  test("stands in the transcript until the saved request is there", () => {
    // Sent into a conversation with one earlier request: the turn is still
    // running, then it has ended but the refetch has not landed yet.
    expect(optimisticVisible(pending(), 3, [user, assistant])).toBe(true);
    // The saved request arrived: the stand-in goes, in the same render.
    expect(optimisticVisible(pending(), 3, [user, assistant, user])).toBe(false);
  });

  test("a new conversation keeps it while its detail is still loading", () => {
    expect(optimisticVisible(pending({ baseline: 0 }), 3, [])).toBe(true);
    expect(optimisticVisible(pending({ baseline: 0 }), 3, [user])).toBe(false);
  });

  test("belongs to the session it was sent in", () => {
    expect(optimisticVisible(pending(), 4, [user])).toBe(false);
    expect(optimisticVisible(null, 3, [])).toBe(false);
  });

  test("goes back into the composer only if the engine did not keep it", () => {
    expect(shouldRestoreComposer(pending(), [user, assistant])).toBe(true);
    // A stopped turn that stored the request: putting it back invites a double send.
    expect(shouldRestoreComposer(pending(), [user, assistant, user])).toBe(false);
  });

  test("has the saved request's shape, so its chips render the same", () => {
    const reference = { type: "workflow" as const, id: "w1", label: "customer-sync" };
    const message = optimisticUiMessage(pending({ references: [reference] }));
    expect(message.role).toBe("user");
    expect(referencesFromPart(message.parts[0]).references).toEqual([reference]);
  });
});

describe("a failed first send", () => {
  const sentAt = "2026-09-29T10:00:00.000Z";
  const known = new Set(["old-1"]);

  test("names the conversation the create stream announced", () => {
    expect(
      conversationOpenedByFailedSend({ startedId: "c-new", knownIds: known, sentAt, listed: [] }),
    ).toBe("c-new");
  });

  test("without that frame, finds exactly one conversation created since the send", () => {
    const listed = [
      { id: "old-1", created_at: "2026-09-01T00:00:00.000Z" },
      { id: "c-new", created_at: "2026-09-29T10:00:01.000Z" },
      { id: "filtered-before", created_at: "2026-09-20T00:00:00.000Z" },
    ];
    expect(
      conversationOpenedByFailedSend({ startedId: null, knownIds: known, sentAt, listed }),
    ).toBe("c-new");
  });

  test("never guesses between two new conversations", () => {
    const listed = [
      { id: "c-a", created_at: "2026-09-29T10:00:01.000Z" },
      { id: "c-b", created_at: "2026-09-29T10:00:02.000Z" },
    ];
    expect(
      conversationOpenedByFailedSend({ startedId: null, knownIds: known, sentAt, listed }),
    ).toBeNull();
  });

  test("moves to the opened conversation and keeps the text out when the request was stored", () => {
    expect(
      recoverFailedSend({
        activeId: null,
        openedId: "c-new",
        optimistic: pending({ baseline: 0 }),
        messagesAfter: [user],
      }),
    ).toEqual({ switchTo: "c-new", restoreComposer: false });
  });

  test("moves there and hands the text back when the request was not stored", () => {
    expect(
      recoverFailedSend({
        activeId: null,
        openedId: "c-new",
        optimistic: pending({ baseline: 0 }),
        messagesAfter: [],
      }),
    ).toEqual({ switchTo: "c-new", restoreComposer: true });
  });

  test("with no conversation opened, the text goes back and nothing moves", () => {
    expect(
      recoverFailedSend({
        activeId: null,
        openedId: null,
        optimistic: pending({ baseline: 0 }),
        messagesAfter: null,
      }),
    ).toEqual({ switchTo: null, restoreComposer: true });
  });

  test("a later send stays where it is and restores only a request the engine did not keep", () => {
    expect(
      recoverFailedSend({
        activeId: "c1",
        openedId: null,
        optimistic: pending(),
        messagesAfter: [user, assistant, user],
      }),
    ).toEqual({ switchTo: null, restoreComposer: false });
    expect(
      recoverFailedSend({
        activeId: "c1",
        openedId: null,
        optimistic: pending(),
        messagesAfter: [user, assistant],
      }),
    ).toEqual({ switchTo: null, restoreComposer: true });
  });
});

describe("header title", () => {
  const base = {
    title: null,
    listTitle: null,
    failed: false,
    activeId: "c1",
    startedHere: false,
    loaded: false,
  };

  test("a conversation begun here stays 'new' while it loads and after, until it is named", () => {
    expect(chatHeaderTitle({ ...base, activeId: null, startedHere: true })).toEqual({
      kind: "new",
    });
    expect(chatHeaderTitle({ ...base, startedHere: true })).toEqual({ kind: "new" });
    expect(chatHeaderTitle({ ...base, startedHere: true, loaded: true })).toEqual({ kind: "new" });
    expect(chatHeaderTitle({ ...base, startedHere: true, title: "Notion-Workflows" })).toEqual({
      kind: "title",
      text: "Notion-Workflows",
    });
  });

  test("an opened conversation reads the list's title while it loads, never 'new'", () => {
    expect(chatHeaderTitle({ ...base, listTitle: "Monatsreport" })).toEqual({
      kind: "title",
      text: "Monatsreport",
    });
    expect(chatHeaderTitle(base)).toEqual({ kind: "loading" });
    expect(chatHeaderTitle({ ...base, loaded: true })).toEqual({ kind: "untitled" });
  });

  test("a conversation that cannot be opened says so", () => {
    expect(chatHeaderTitle({ ...base, failed: true })).toEqual({ kind: "unavailable" });
  });
});

describe("header pills", () => {
  test("no bare zero: tokens only when there are some", () => {
    expect(tokenPill(null)).toBeNull();
    expect(tokenPill({ tokens: 0 })).toBeNull();
    expect(tokenPill({ tokens: 1234 })).toBe(1234);
  });

  test("cost only when priced, and a floor when a model had no rate", () => {
    expect(costPill({ cost: null })).toBeNull();
    expect(costPill({ cost: { amount: 0.42, currency: "EUR", unpriced_models: [] } })).toEqual({
      amount: 0.42,
      currency: "EUR",
      floor: false,
    });
    expect(costPill({ cost: { amount: 0.42, currency: "EUR", unpriced_models: ["x"] } })).toEqual({
      amount: 0.42,
      currency: "EUR",
      floor: true,
    });
  });

  test("the month's allowance only when it asks for attention", () => {
    expect(budgetPill("ample")).toBeNull();
    expect(budgetPill(null)).toBeNull();
    expect(budgetPill(undefined)).toBeNull();
    expect(budgetPill("tightening")).toBe("tightening");
    expect(budgetPill("critical")).toBe("critical");
  });
});
