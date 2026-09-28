import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { translate } from "@/lib/i18n";
import { conversationFailureKind, retryConversationRead } from "./chat-load-failure";

const refusal = (status: number) =>
  new ApiError(status, { code: "not_found", message: "conversation not found" }, null);

describe("a conversation that cannot be opened", () => {
  test("unknown or not the reader's is final — retrying cannot help", () => {
    expect(conversationFailureKind(refusal(404))).toBe("missing");
    expect(conversationFailureKind(refusal(403))).toBe("missing");
  });

  test("a server error or a lost connection is transient", () => {
    expect(conversationFailureKind(refusal(500))).toBe("transient");
    expect(conversationFailureKind(refusal(503))).toBe("transient");
    expect(conversationFailureKind(new TypeError("Failed to fetch"))).toBe("transient");
    expect(conversationFailureKind(null)).toBe("transient");
  });

  test("a refusal is not retried; a transient failure is, three times", () => {
    expect(retryConversationRead(0, refusal(404))).toBe(false);
    expect(retryConversationRead(0, refusal(403))).toBe(false);
    expect(retryConversationRead(0, refusal(500))).toBe(true);
    expect(retryConversationRead(2, refusal(500))).toBe(true);
    expect(retryConversationRead(3, refusal(500))).toBe(false);
  });

  test("the missing case says so, and never tells the reader to try again", () => {
    expect(translate("de", "chat.notFound")).toBe(
      "Diese Unterhaltung gibt es nicht oder du hast keinen Zugriff",
    );
    for (const locale of ["de", "en"] as const) {
      const description = translate(locale, "chat.notFoundDescription");
      expect(description).not.toBe(translate(locale, "resource.loadFailedDescription"));
    }
    expect(translate("de", "chat.notFoundDescription")).not.toMatch(/Lad die Seite neu/);
  });
});
