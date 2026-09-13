import { describe, expect, test } from "bun:test";

import type { SlashHandlerContext } from "../repl/slash/handler.ts";
import { dispatchInspectSlash } from "../repl/slash/handlers/inspect.ts";

function buildCtx(overrides: Partial<SlashHandlerContext> = {}): SlashHandlerContext {
  // Minimal stub. `dispatchInspectSlash` only needs `client` for
  // /skills /mcp /audit /knowledge and `allowedPermissions` for
  // /permissions. `panify` falls back to a banner string when
  // `openPane` is absent.
  return {
    client: {} as SlashHandlerContext["client"],
    profile: {} as SlashHandlerContext["profile"],
    session: {} as SlashHandlerContext["session"],
    setConversationId: () => {},
    allowedPermissions: [],
    ...overrides,
  };
}

describe("dispatchInspectSlash", () => {
  test("/permissions with no allow-set returns the empty banner", async () => {
    const result = await dispatchInspectSlash("permissions", buildCtx());
    expect(result).toBe("no permissions probe cached");
  });

  test("/permissions panifies the allowed list", async () => {
    const result = await dispatchInspectSlash(
      "permissions",
      buildCtx({ allowedPermissions: ["audit:read", "conversation:read"] }),
    );
    // Banner shape: title \n \n indented rows.
    expect(result).toContain("permissions");
    expect(result).toContain("audit:read");
    expect(result).toContain("conversation:read");
  });

  test("returns undefined for unknown names — caller falls through", async () => {
    const result = await dispatchInspectSlash("not-a-real-inspect-slash", buildCtx());
    expect(result).toBeUndefined();
  });

  test("/skills returns the banner when the client lists none", async () => {
    const ctx = buildCtx({
      client: {
        listSkills: () => Promise.resolve({ items: [] }),
      } as unknown as SlashHandlerContext["client"],
    });
    const result = await dispatchInspectSlash("skills", ctx);
    expect(result).toBe("no skills in scope");
  });
});
