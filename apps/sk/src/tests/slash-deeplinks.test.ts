// Verifies the claude-code-parity deep-links route through openPane
// with the right SettingsModal initialTab.
//
// /config → { kind: "settings", initialTab: "Config" }
// /usage  → { kind: "settings", initialTab: "Usage" }
// /skills → { kind: "settings", initialTab: "Skills" }   (was text-panify)
// /knowledge → { kind: "settings", initialTab: "Knowledge" } (was text-panify)
//
// The legacy 4-field /config form moved to /config-form (covered in
// slash-config-form-renamed.test.ts).

import { describe, expect, test } from "bun:test";
import type { PaneSpec, SlashHandlerContext } from "../repl/slash/handler.ts";
import { dispatchInspectSlash } from "../repl/slash/handlers/inspect.ts";

function ctxWithPane(): {
  ctx: SlashHandlerContext;
  panes: PaneSpec[];
} {
  const panes: PaneSpec[] = [];
  const ctx = {
    client: {} as SlashHandlerContext["client"],
    profile: {} as SlashHandlerContext["profile"],
    session: {} as SlashHandlerContext["session"],
    setConversationId: () => {},
    allowedPermissions: [],
    openPane: (spec: PaneSpec) => {
      panes.push(spec);
    },
  } as SlashHandlerContext;
  return { ctx, panes };
}

describe("Slash deep-links → SettingsModal", () => {
  test("/skills opens SettingsModal on the Skills tab when an Ink host is available", async () => {
    const { ctx, panes } = ctxWithPane();
    const result = await dispatchInspectSlash("skills", ctx);
    expect(result).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]).toEqual({ kind: "settings", initialTab: "Skills" });
  });

  test("/knowledge opens SettingsModal on the Knowledge tab", async () => {
    const { ctx, panes } = ctxWithPane();
    const result = await dispatchInspectSlash("knowledge", ctx);
    expect(result).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]).toEqual({ kind: "settings", initialTab: "Knowledge" });
  });

  test("/permissions opens the PermissionsCommand SinglePane (not the Settings tab)", async () => {
    const { ctx, panes } = ctxWithPane();
    const result = await dispatchInspectSlash("permissions", ctx);
    expect(result).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]?.kind).toBe("permissions");
    // Critical: NOT a settings pane.
    expect(panes[0]).not.toEqual({ kind: "settings", initialTab: "Permissions" });
  });

  test("/admin opens the AdminCommand SinglePane (not the Settings tab)", async () => {
    const { ctx, panes } = ctxWithPane();
    const result = await dispatchInspectSlash("admin", ctx);
    expect(result).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]?.kind).toBe("admin");
    // Critical: NOT a settings pane.
    expect(panes[0]).not.toEqual({ kind: "settings", initialTab: "Admin" });
  });

  test("readline fallback (no openPane) still works for /skills", async () => {
    const ctx = {
      client: {
        listSkills: async () => ({ items: [] }),
      } as unknown as SlashHandlerContext["client"],
      profile: {} as SlashHandlerContext["profile"],
      session: {} as SlashHandlerContext["session"],
      setConversationId: () => {},
      allowedPermissions: [],
    } as SlashHandlerContext;
    const result = await dispatchInspectSlash("skills", ctx);
    expect(result).toBe("no skills in scope");
  });

  test("readline fallback for /admin says to open the Ink REPL", async () => {
    const ctx = {
      client: {} as SlashHandlerContext["client"],
      profile: {} as SlashHandlerContext["profile"],
      session: {} as SlashHandlerContext["session"],
      setConversationId: () => {},
      allowedPermissions: [],
    } as SlashHandlerContext;
    const result = await dispatchInspectSlash("admin", ctx);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("/admin");
  });
});
