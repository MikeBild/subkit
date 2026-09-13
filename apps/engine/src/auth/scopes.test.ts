// The credential-scope marker/permission split (Stream 1b, C1 + C2).

import { describe, expect, test } from "bun:test";

import { isCeilingScope, isMcpModeMarkerScope, WILDCARD_SCOPE } from "./scopes.ts";

describe("isMcpModeMarkerScope", () => {
  test("the whole mcp:* family is a marker", () => {
    for (const s of ["mcp:read", "mcp:authoring", "mcp:admin", "mcp:future"]) {
      expect(isMcpModeMarkerScope(s)).toBe(true);
    }
  });
  test("resource:action scopes and the wildcard are not markers", () => {
    for (const s of ["connector:write", "workflow:read", WILDCARD_SCOPE]) {
      expect(isMcpModeMarkerScope(s)).toBe(false);
    }
  });
});

describe("isCeilingScope", () => {
  test("only resource:action scopes participate in the ceiling", () => {
    expect(isCeilingScope("connector:write")).toBe(true);
    expect(isCeilingScope("workflow:read")).toBe(true);
  });
  test("the wildcard never narrows", () => {
    expect(isCeilingScope(WILDCARD_SCOPE)).toBe(false);
  });
  test("mcp:* markers never narrow", () => {
    for (const s of ["mcp:read", "mcp:authoring", "mcp:admin"]) {
      expect(isCeilingScope(s)).toBe(false);
    }
  });
});
