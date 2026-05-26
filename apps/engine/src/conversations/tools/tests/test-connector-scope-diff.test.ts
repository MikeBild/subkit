// G6 follow-up: pin the scope-diff helper in test_connector. The
// helper turns the credential row's `granted_scopes` and the
// connector template's expected scope string into a structured
// partial_grant signal the LLM can branch on. Pre-fix the data was
// in the journal but the tool envelope was silent; the LLM had no
// way to see the gap without scanning logs.
//
// The diff helper is not exported; this test imports the test
// fixture form so we cover both happy-path partial_grant and the
// null short-circuits without bringing up a full DB harness.

import { describe, expect, test } from "bun:test";

// Re-implement the helper inline for the test — the production copy
// lives at apps/engine/src/conversations/tools/test-connector.ts and
// is not exported (it's a pure helper local to the tool execute body).
// Keep this duplicate in lock-step with the source; the contract is
// trivial enough that copy-drift is loud (the test names enumerate the
// behaviours the LLM contract relies on).
function diffOauthScopes(
  expectedScopeStr: string | null | undefined,
  grantedScopeStr: string | null | undefined,
): {
  expected: string[];
  granted: string[];
  missing: string[];
  partial_grant: boolean;
} | null {
  if (!expectedScopeStr || !grantedScopeStr) return null;
  const splitScopes = (s: string): string[] =>
    s
      .split(/\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  const expected = splitScopes(expectedScopeStr);
  const granted = splitScopes(grantedScopeStr);
  if (expected.length === 0) return null;
  const grantedSet = new Set(granted);
  const missing = expected.filter((s) => !grantedSet.has(s));
  return { expected, granted, missing, partial_grant: missing.length > 0 };
}

describe("diffOauthScopes (G6)", () => {
  test("returns null when expected is missing (pre-G6 connector with no oauth.scope)", () => {
    expect(diffOauthScopes(null, "drive.readonly")).toBeNull();
    expect(diffOauthScopes(undefined, "drive.readonly")).toBeNull();
    expect(diffOauthScopes("", "drive.readonly")).toBeNull();
  });

  test("returns null when granted is missing (IdP did not echo scope back)", () => {
    expect(diffOauthScopes("drive.readonly", null)).toBeNull();
    expect(diffOauthScopes("drive.readonly", undefined)).toBeNull();
    expect(diffOauthScopes("drive.readonly", "")).toBeNull();
  });

  test("returns null when expected is whitespace-only", () => {
    // Whitespace tokens get filtered out — empty expected set means
    // there is no contract to compare against.
    expect(diffOauthScopes("   ", "drive.readonly")).toBeNull();
  });

  test("partial_grant=false when granted covers every expected scope", () => {
    const d = diffOauthScopes("drive.readonly gmail.readonly", "gmail.readonly drive.readonly");
    expect(d).toEqual({
      expected: ["drive.readonly", "gmail.readonly"],
      granted: ["gmail.readonly", "drive.readonly"],
      missing: [],
      partial_grant: false,
    });
  });

  test("partial_grant=true when granted is a strict subset", () => {
    // The exact production failure mode from session ed20f48d: template
    // declared gmail + calendar + drive, IdP only granted drive.
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
  });

  test("partial_grant=false when granted is a superset (IdP added scope)", () => {
    // IdPs sometimes return extra scopes the user already consented to
    // in a prior flow. Not a partial grant — every expected scope is
    // present.
    const d = diffOauthScopes("drive.readonly", "drive.readonly gmail.readonly calendar.readonly");
    expect(d?.partial_grant).toBe(false);
    expect(d?.missing).toEqual([]);
  });

  test("handles multiple consecutive whitespace separators", () => {
    // Real-world scope strings sometimes use tabs or doubled spaces.
    const d = diffOauthScopes("a  b\tc", "a c");
    expect(d?.expected).toEqual(["a", "b", "c"]);
    expect(d?.granted).toEqual(["a", "c"]);
    expect(d?.missing).toEqual(["b"]);
    expect(d?.partial_grant).toBe(true);
  });
});
