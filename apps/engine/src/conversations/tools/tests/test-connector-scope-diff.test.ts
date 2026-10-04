import { describe, expect, test } from "bun:test";
import { diffOauthScopes } from "../../../connectors/oauth-scope-diff.ts";

describe("diffOauthScopes (G6 / H4)", () => {
  test("returns null when expected is missing (no template scope contract)", () => {
    expect(diffOauthScopes(null, "drive.readonly")).toBeNull();
    expect(diffOauthScopes(undefined, "drive.readonly")).toBeNull();
    expect(diffOauthScopes("", "drive.readonly")).toBeNull();
  });

  test("returns null when expected is whitespace-only", () => {
    expect(diffOauthScopes("   ", "drive.readonly")).toBeNull();
  });

  test('H4: expected known but granted missing → partial_grant="unknown"', () => {
    expect(diffOauthScopes("drive.readonly", null)).toMatchObject({
      partial_grant: "unknown",
      expected: ["drive.readonly"],
      granted: [],
      missing: [],
    });
    expect(diffOauthScopes("drive.readonly", undefined)?.partial_grant).toBe("unknown");
    expect(diffOauthScopes("drive.readonly", "")?.partial_grant).toBe("unknown");
  });

  test("partial_grant=false when granted covers every expected scope", () => {
    const d = diffOauthScopes("drive.readonly gmail.readonly", "gmail.readonly drive.readonly");
    expect(d).toMatchObject({
      expected: ["drive.readonly", "gmail.readonly"],
      granted: ["gmail.readonly", "drive.readonly"],
      missing: [],
      partial_grant: false,
    });
    expect(d?.note).toBeUndefined();
  });

  test("partial_grant=true when granted is a strict subset (the ed20f48d scenario)", () => {
    const d = diffOauthScopes(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    );
    expect(d?.partial_grant).toBe(true);
    expect(d?.missing).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(d?.granted).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
    expect(d?.note).toContain("1/3 requested scopes");
    expect(d?.note).toContain("Re-run authenticate_oauth");
  });

  test("partial_grant=false when granted is a superset (IdP added extras)", () => {
    const d = diffOauthScopes("drive.readonly", "drive.readonly gmail.readonly calendar.readonly");
    expect(d?.partial_grant).toBe(false);
    expect(d?.missing).toEqual([]);
  });

  test("handles multiple consecutive whitespace separators", () => {
    const d = diffOauthScopes("a  b\tc", "a c");
    expect(d?.expected).toEqual(["a", "b", "c"]);
    expect(d?.granted).toEqual(["a", "c"]);
    expect(d?.missing).toEqual(["b"]);
    expect(d?.partial_grant).toBe(true);
  });
});
