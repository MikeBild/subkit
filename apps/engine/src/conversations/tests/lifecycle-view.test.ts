import { describe, expect, test } from "bun:test";
import {
  deriveConversationOutcome,
  STALE_AFTER_DAYS,
  surfaceFromClientHeader,
} from "../lifecycle-view.ts";
import {
  buildTitlePrompt,
  deriveConversationTitle,
  shouldRefreshTitle,
  TITLE_WORDS_MAX,
  titleFromSummary,
  titleSourceRequests,
} from "../title.ts";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

describe("deriveConversationOutcome", () => {
  test("an answered question is answered, not active", () => {
    expect(
      deriveConversationOutcome({
        status: "active",
        last_message_role: "assistant",
        last_activity_at: daysAgo(1),
        now: NOW,
      }),
    ).toBe("answered");
  });
  test("a person's message without an answer is in progress", () => {
    expect(
      deriveConversationOutcome({
        status: "active",
        last_message_role: "user",
        last_activity_at: daysAgo(0),
        now: NOW,
      }),
    ).toBe("in_progress");
  });
  test("a tool row as the last row is in progress too", () => {
    expect(
      deriveConversationOutcome({
        status: "active",
        last_message_role: "tool",
        last_activity_at: daysAgo(0),
        now: NOW,
      }),
    ).toBe("in_progress");
  });
  test("awaiting_input waits for the reader whatever the last row", () => {
    expect(
      deriveConversationOutcome({
        status: "awaiting_input",
        last_message_role: "assistant",
        last_activity_at: daysAgo(0),
        now: NOW,
      }),
    ).toBe("awaiting_you");
  });
  test("terminal statuses pass through", () => {
    for (const status of ["committed", "abandoned"] as const) {
      expect(
        deriveConversationOutcome({
          status,
          last_message_role: "assistant",
          last_activity_at: daysAgo(0),
          now: NOW,
        }),
      ).toBe(status);
    }
  });
  test("an answered conversation goes stale after the window, not before", () => {
    const fresh = deriveConversationOutcome({
      status: "active",
      last_message_role: "assistant",
      last_activity_at: daysAgo(STALE_AFTER_DAYS - 1),
      now: NOW,
    });
    const old = deriveConversationOutcome({
      status: "active",
      last_message_role: "assistant",
      last_activity_at: daysAgo(STALE_AFTER_DAYS + 1),
      now: NOW,
    });
    expect(fresh).toBe("answered");
    expect(old).toBe("stale");
  });
  test("an empty conversation is answered-nothing: in progress", () => {
    expect(
      deriveConversationOutcome({
        status: "active",
        last_message_role: null,
        last_activity_at: null,
        now: NOW,
      }),
    ).toBe("in_progress");
  });
});

describe("surfaceFromClientHeader", () => {
  test("maps the Cockpit header, subkit modes and the bare API", () => {
    expect(surfaceFromClientHeader("cockpit")).toBe("web");
    expect(surfaceFromClientHeader("Cockpit ")).toBe("web");
    expect(surfaceFromClientHeader("subkit")).toBe("sk_interactive");
    expect(surfaceFromClientHeader("sk_headless")).toBe("sk_headless");
    expect(surfaceFromClientHeader(undefined)).toBe("api");
    expect(surfaceFromClientHeader("curl/8")).toBe("api");
  });
});

describe("automatic title", () => {
  test("refreshes after the first answer and every fifth turn, never when locked", () => {
    expect(shouldRefreshTitle(1, false)).toBe(true);
    expect(shouldRefreshTitle(2, false)).toBe(false);
    expect(shouldRefreshTitle(5, false)).toBe(true);
    expect(shouldRefreshTitle(10, false)).toBe(true);
    expect(shouldRefreshTitle(1, true)).toBe(false);
    expect(shouldRefreshTitle(5, true)).toBe(false);
  });
  test("titleFromSummary strips quotes and periods and takes the first line only", () => {
    expect(titleFromSummary('"Monatsreport reparieren."\nMore text')).toBe(
      "Monatsreport reparieren",
    );
    expect(titleFromSummary("„Stripe-Connector anlegen“")).toBe("Stripe-Connector anlegen");
    expect(titleFromSummary("   \n  Run the weather demo!")).toBe("Run the weather demo");
    expect(titleFromSummary("")).toBeNull();
    expect(titleFromSummary('""')).toBeNull();
  });
  test("titleFromSummary caps the word count and stores whole words without an ellipsis", () => {
    const long = Array.from({ length: 20 }, (_, i) => `Datenbankverbindungsprüfung${i}`).join(" ");
    const title = titleFromSummary(long);
    expect(title).not.toBeNull();
    expect(title!.split(" ")).toEqual(long.split(" ").slice(0, TITLE_WORDS_MAX));
    expect(title).not.toContain("…");
  });
  test("the opening line is stored whole; only the screen shortens it", () => {
    const opening =
      "Bitte prüfe den fehlgeschlagenen Lauf des wöchentlichen Wachstumsberichts und schlage eine Reparatur vor";
    expect(deriveConversationTitle({ text: `  ${opening}\n` })).toBe(opening);
  });
  test("a fragment that announces more text is not a title", () => {
    expect(titleFromSummary("Hier ist die Reparatur:")).toBeNull();
    expect(titleFromSummary("Ich prüfe jetzt …")).toBeNull();
    expect(titleFromSummary("Let me check...")).toBeNull();
    expect(titleFromSummary("Fehlgeschlagenen Lauf reparieren")).toBe(
      "Fehlgeschlagenen Lauf reparieren",
    );
  });
  test("buildTitlePrompt names the person's requests and nothing the assistant wrote", () => {
    const prompt = buildTitlePrompt([
      "Warum ist dieser Lauf fehlgeschlagen, und wie behebe ich das?",
      "Ja",
    ]);
    expect(prompt).toContain("in the language the person writes in");
    expect(prompt).toContain("imperative verb");
    expect(prompt).toContain("- Warum ist dieser Lauf fehlgeschlagen, und wie behebe ich das?");
    expect(prompt).toContain("- Ja");
    expect(prompt).not.toContain("Assistant:");
    expect(prompt).toContain("Reply with the title only");
  });
  test("the title source is the person's requests, without recorded approval decisions", () => {
    expect(
      titleSourceRequests([
        { content: { text: "Prüfe den Editorial-Workflow" } },
        { content: { kind: "confirmation_decision", text: "✓ Approved: call_connector" } },
        { content: {} },
        { content: { text: "Ja" } },
      ]),
    ).toEqual(["Prüfe den Editorial-Workflow", "Ja"]);
  });
});
