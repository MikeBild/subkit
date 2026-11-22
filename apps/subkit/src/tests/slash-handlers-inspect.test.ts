import { describe, expect, test } from "bun:test";
import type { SlashHandlerContext } from "../repl/slash/handler.ts";
import { dispatchInspectSlash } from "../repl/slash/handlers/inspect.ts";

function buildCtx(overrides: Partial<SlashHandlerContext> = {}): SlashHandlerContext {
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

  test("/audit renders ts, action and a short resource id, blank when null", async () => {
    const ctx = buildCtx({
      client: {
        tailAuditLog: () =>
          Promise.resolve({
            items: [
              { ts: "2026-01-01T00:00:00Z", action: "rbac.role.create", resource_id: "r123456789" },
              { ts: "2026-01-02T00:00:00Z", action: "auth.login", resource_id: null },
            ],
          }),
      } as unknown as SlashHandlerContext["client"],
    });
    const result = await dispatchInspectSlash("audit", ctx);
    expect(result).toContain("2026-01-01T00:00:00Z  rbac.role.create             r1234567");
    expect(result).toMatch(/2026-01-02T00:00:00Z {2}auth\.login {18} $/m);
    expect(result).toContain("latest 2");
  });

  test("/knowledge without a pane lists name and source type", async () => {
    const ctx = buildCtx({
      client: {
        listKnowledgeSources: () =>
          Promise.resolve({
            items: [{ id: "ks123456789", name: "Runbook", source_type: "upload" }],
          }),
      } as unknown as SlashHandlerContext["client"],
    });
    const result = await dispatchInspectSlash("knowledge", ctx);
    expect(result).toContain("ks123456  Runbook  upload");
    expect(result).toContain("1 found");
  });
});
