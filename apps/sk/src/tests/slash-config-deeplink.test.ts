import { describe, expect, mock, test } from "bun:test";
import type { SkSessionState } from "@cli-core/index.ts";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { handleSlash, type PaneSpec, type SlashHandlerContext } from "../repl/slash/handler.ts";

function buildCtx(): { ctx: SlashHandlerContext; panes: PaneSpec[] } {
  const panes: PaneSpec[] = [];
  const ctx: SlashHandlerContext = {
    client: {
      patchConversation: mock(async () => ({})),
    } as unknown as EngineClient,
    profile: {
      name: "default",
      engine_url: "http://localhost:3000",
    } as ResolvedProfile,
    session: {
      conversationId: null,
      status: "idle",
      messages: [],
      toolCalls: [],
      usage: null,
    } as unknown as SkSessionState,
    setConversationId: () => {},
    allowedPermissions: [],
    openPane: (spec) => {
      panes.push(spec);
    },
  };
  return { ctx, panes };
}

describe("/config — deep-link into SettingsModal Config tab", () => {
  test("opens kind:'settings' with initialTab:'Config'", async () => {
    const { ctx, panes } = buildCtx();
    const out = await handleSlash("config", [], ctx);
    expect(out).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]).toEqual({ kind: "settings", initialTab: "Config" });
  });

  test("readline fallback (no openPane) returns guidance string", async () => {
    const { ctx } = buildCtx();
    delete (ctx as { openPane?: unknown }).openPane;
    const out = await handleSlash("config", [], ctx);
    expect(typeof out).toBe("string");
    expect(out as string).toContain("/config");
  });
});

describe("/settings — opens the tenant-scoped SettingsModal", () => {
  test("carries the active tenant id into the pane", async () => {
    const { ctx, panes } = buildCtx();
    ctx.statusSnapshot = {
      tenant: { id: "11111111-1111-1111-1111-111111111111", slug: "default" },
    } as NonNullable<SlashHandlerContext["statusSnapshot"]>;

    const out = await handleSlash("settings", [], ctx);
    expect(out).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]).toEqual({
      kind: "settings",
      tenant: "11111111-1111-1111-1111-111111111111",
    });
  });
});

describe("/usage — deep-link into SettingsModal Usage tab", () => {
  test("opens kind:'settings' with initialTab:'Usage'", async () => {
    const { ctx, panes } = buildCtx();
    const out = await handleSlash("usage", [], ctx);
    expect(out).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]).toEqual({ kind: "settings", initialTab: "Usage" });
  });
});

describe("/config-form — the 4-field settings prompt is reachable", () => {
  test("opens the kind:'config-form' pane", async () => {
    const { ctx, panes } = buildCtx();
    const out = await handleSlash("config-form", [], ctx);
    expect(out).toBeNull();
    expect(panes.length).toBe(1);
    const spec = panes[0];
    expect(spec?.kind).toBe("config-form");
    if (spec?.kind === "config-form") {
      expect(spec.title).toBe("config-form");
      expect(spec.fields.map((f) => f.name)).toEqual([
        "model",
        "includeMemoryFile",
        "maxInlineMentionBytes",
        "statusLineRefreshMs",
      ]);
    }
  });
});

describe("/profile — opens the ProfileCommand SinglePane when no positional arg", () => {
  test("no arg → kind:'profile'", async () => {
    const { ctx, panes } = buildCtx();
    const out = await handleSlash("profile", [], ctx);
    expect(out).toBeNull();
    expect(panes.length).toBe(1);
    expect(panes[0]?.kind).toBe("profile");
    expect(panes[0]).not.toEqual({ kind: "settings", initialTab: "Profile" });
  });
});
