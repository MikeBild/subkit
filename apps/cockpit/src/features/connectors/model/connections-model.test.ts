import { describe, expect, test } from "bun:test";
import {
  connectionNeedsRenewal,
  connectionReasonKey,
  connectionStateKey,
  parseTypedScopes,
  suggestConnectionName,
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

  test("suggests a name from the service, else from the host, always as a slug", () => {
    expect(suggestConnectionName("Probe Service", "https://x.example")).toBe("probe-service");
    expect(suggestConnectionName("Über Wiki", "https://x.example")).toBe("uber-wiki");
    expect(suggestConnectionName(null, "https://www.wiki.example.com/api")).toBe("wiki");
    expect(suggestConnectionName("   ", "not a url")).toBe("konto");
    expect(suggestConnectionName("---", "https://x.example")).toBe("x");
  });

  test("every reason the engine records has its own sentence", () => {
    expect(connectionReasonKey("refresh_refused")).toBe("connections.reason.refreshRefused");
    expect(connectionReasonKey("refresh_failed")).toBe("connections.reason.refreshFailed");
    expect(connectionReasonKey("expired_no_refresh")).toBe("connections.reason.expiredNoRefresh");
    expect(connectionReasonKey("secret_unreadable")).toBe("connections.reason.secretUnreadable");
  });

  test("typed scopes split on space or comma and de-duplicate", () => {
    expect(parseTypedScopes("read, write read\nadmin")).toEqual(["read", "write", "admin"]);
    expect(parseTypedScopes("  ")).toEqual([]);
  });
});
