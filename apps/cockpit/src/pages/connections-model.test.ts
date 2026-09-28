import { describe, expect, test } from "bun:test";
import {
  connectionFailureKey,
  connectionNeedsRenewal,
  connectionReasonKey,
  connectionStateKey,
  parseTypedScopes,
  readCallbackOutcome,
  suggestConnectionName,
  withoutCallbackParams,
} from "./connections-model";

describe("connections model", () => {
  test("every state has its word and only a lost grant asks for renewal", () => {
    expect(connectionStateKey("valid")).toBe("connections.state.valid");
    expect(connectionStateKey("expiring")).toBe("connections.state.expiring");
    expect(connectionStateKey("expired")).toBe("connections.state.expired");
    expect(connectionStateKey("unreadable")).toBe("connections.state.unreadable");
    expect(connectionNeedsRenewal({ state: "valid" })).toBe(false);
    expect(connectionNeedsRenewal({ state: "expiring" })).toBe(false);
    expect(connectionNeedsRenewal({ state: "expired" })).toBe(true);
    expect(connectionNeedsRenewal({ state: "unreadable" })).toBe(true);
  });

  test("a failure code becomes one sentence, and an unknown one is still a sentence", () => {
    expect(connectionFailureKey("denied")).toBe("connections.failure.denied");
    expect(connectionFailureKey("registration_missing")).toBe(
      "connections.failure.registrationMissing",
    );
    expect(connectionFailureKey("something_new")).toBe("connections.failure.other");
    expect(connectionFailureKey(null)).toBe("connections.failure.other");
  });

  test("suggests a name from the service, else from the host, always as a slug", () => {
    expect(suggestConnectionName("Probe Service", "https://x.example")).toBe("probe-service");
    expect(suggestConnectionName("Über Wiki", "https://x.example")).toBe("uber-wiki");
    expect(suggestConnectionName(null, "https://www.wiki.example.com/api")).toBe("wiki");
    expect(suggestConnectionName("   ", "not a url")).toBe("konto");
    expect(suggestConnectionName("---", "https://x.example")).toBe("x");
  });

  test("reads the callback outcome off the query string", () => {
    expect(readCallbackOutcome("?connected=wiki")).toEqual({
      kind: "connected",
      name: "wiki",
      renewed: false,
    });
    expect(readCallbackOutcome("?connected=wiki&renewed=1")).toEqual({
      kind: "connected",
      name: "wiki",
      renewed: true,
    });
    expect(readCallbackOutcome("?failed=denied&name=wiki")).toEqual({
      kind: "failed",
      code: "denied",
      name: "wiki",
    });
    expect(readCallbackOutcome("")).toBeNull();
  });

  test("every reason the engine records has its own sentence", () => {
    expect(connectionReasonKey("refresh_failed")).toBe("connections.reason.refreshFailed");
    expect(connectionReasonKey("expired_no_refresh")).toBe("connections.reason.expiredNoRefresh");
    expect(connectionReasonKey("secret_unreadable")).toBe("connections.reason.secretUnreadable");
  });

  test("dropping the callback's words keeps the section the page is open at", () => {
    // The old page cleared the whole query, which would now also drop
    // `section=grants` and scroll a returning person to the top.
    expect(withoutCallbackParams("?section=grants&connected=wiki&renewed=1")).toBe(
      "?section=grants",
    );
    expect(withoutCallbackParams("?failed=denied&name=wiki")).toBe("");
  });

  test("typed scopes split on space or comma and de-duplicate", () => {
    expect(parseTypedScopes("read, write read\nadmin")).toEqual(["read", "write", "admin"]);
    expect(parseTypedScopes("  ")).toEqual([]);
  });
});
