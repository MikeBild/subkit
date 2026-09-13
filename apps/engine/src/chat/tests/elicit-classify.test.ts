// Unit coverage for classifyChatElicitError — the graceful-degradation
// mapping. Focus: a resumed chat turn that reaches for a tool absent from
// the read-only palette (an authoring/write tool the model offered but chat
// cannot run) must classify as `surface_unsupported` so the caller posts an
// actionable redirect instead of rethrowing into the queue (which DLQs and
// leaves the user with Google Chat's opaque error card).

import { NoSuchToolError } from "ai";
import { describe, expect, test } from "bun:test";

import { classifyChatElicitError } from "../elicit-routing.ts";

describe("classifyChatElicitError — surface_unsupported", () => {
  test("NoSuchToolError (authoring tool on chat) → surface_unsupported with a redirect", () => {
    const err = new NoSuchToolError({ toolName: "create_skill" });
    const c = classifyChatElicitError(err);
    expect(c.kind).toBe("surface_unsupported");
    if (c.kind === "surface_unsupported") {
      expect(c.tool_name).toBe("create_skill");
      expect(c.user_text.toLowerCase()).toContain("read-only");
      expect(c.user_text).toMatch(/sk CLI|portal/i);
    }
  });

  test("an unrelated error still falls through to rethrow", () => {
    expect(classifyChatElicitError(new Error("boom")).kind).toBe("rethrow");
  });
});
