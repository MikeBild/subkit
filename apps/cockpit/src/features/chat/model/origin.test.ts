import { describe, expect, test } from "bun:test";
import { formatShortRelativeTime } from "@/lib/i18n";
import { originLine } from "./labels";

const t = ((key: string) =>
  ({
    "chat.origin.web": "Cockpit",
    "chat.origin.api": "API",
    "chat.origin.sk_interactive": "subkit",
    "chat.origin.mcp": "MCP",
    "chat.origin.chat": "Chat",
    "chat.origin.slack": "Slack",
    "chat.origin.google_chat": "Google Chat",
    "chat.origin.sk_headless": "subkit (headless)",
  })[key] ?? key) as never;

const at = "2026-09-04T06:00:00.000Z";
const now = Date.parse("2026-09-04T08:00:00.000Z");

describe("originLine", () => {
  test("names a known source, the time, and stops there for your own conversation", () => {
    const line = originLine(t, "en", {
      surface: "web",
      owner: { id: "u1", name: "mike@example.com" },
      viewerId: "u1",
      at,
    });
    expect(line.startsWith("Cockpit · ")).toBe(true);
    expect(line).not.toContain("mike@example.com");
  });

  test("someone else's conversation names them", () => {
    const line = originLine(t, "en", {
      surface: "api",
      owner: { id: "u2", name: "ada@example.com" },
      viewerId: "u1",
      at,
    });
    expect(line).toContain("ada@example.com");
  });

  test("an unknown source is left out rather than spelled out", () => {
    const line = originLine(t, "en", { surface: null, owner: null, viewerId: "u1", at });
    expect(line).not.toMatch(/unknown/i);
    expect(line).not.toContain("chat.origin.unknown");
    expect(line.startsWith("·")).toBe(false);
  });

  test("a conversation with nothing to report produces an empty line, not a stub", () => {
    expect(originLine(t, "en", { surface: null, owner: null, viewerId: "u1", at: null })).toBe("");
  });
});

describe("formatShortRelativeTime", () => {
  test("is a stamp, not a sentence", () => {
    const stamp = formatShortRelativeTime("en", at, "now", now);
    expect(stamp).not.toMatch(/ago|in /);
    expect(stamp.length).toBeLessThanOrEqual(7);
  });

  test("uses the reader's language for the unit", () => {
    const de = formatShortRelativeTime("de", "2026-08-14T08:00:00.000Z", "jetzt", now);
    expect(de).not.toContain("vor");
    expect(de).toMatch(/\d/);
  });

  test("the last minute reads as now", () => {
    expect(formatShortRelativeTime("en", "2026-09-04T07:59:30.000Z", "now", now)).toBe("now");
  });

  test("an unparsable stamp is empty rather than NaN", () => {
    expect(formatShortRelativeTime("en", "not a date", "now", now)).toBe("");
  });

  test("a conversation from a chat channel names the platform it came from", () => {
    const line = originLine(t, "en", {
      surface: "chat",
      client: "chat:google_chat",
      viewerId: null,
    });
    expect(line).toBe("Google Chat");
  });

  test("a chat conversation without a known platform still reads as a chat channel", () => {
    expect(originLine(t, "en", { surface: "chat", client: null, viewerId: null })).toBe("Chat");
    expect(originLine(t, "en", { surface: "web", client: "chat:slack", viewerId: null })).toBe(
      "Cockpit",
    );
  });
});
