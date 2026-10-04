import { describe, expect, test } from "bun:test";
import { NoSuchToolError } from "ai";
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
