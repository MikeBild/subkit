import { describe, expect, mock, test } from "bun:test";
import type { SkSessionState } from "@cli-core/index.ts";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { SUB_COMMANDS } from "../index.ts";
import { unsupportedSlashGuidance } from "../repl/slash/dispatcher.ts";
import { handleSlash, type SlashHandlerContext } from "../repl/slash/handler.ts";
import { SLASH_COMMANDS } from "../slash.ts";

describe("unsupportedSlashGuidance map", () => {
  test("returns the agentic-coding rationale for /agents", () => {
    const hint = unsupportedSlashGuidance("agents");
    expect(hint).toMatch(/no subagent routing/);
    expect(hint).toMatch(/Skills/);
    expect(hint).toMatch(/Knowledge Sources/);
  });

  test("does NOT return guidance for still-registered slashes", () => {
    expect(unsupportedSlashGuidance("health")).toBeNull();
    expect(unsupportedSlashGuidance("preview")).toBeNull();
    expect(unsupportedSlashGuidance("restore")).toBeNull();
  });

  test("returns null for an unmapped name", () => {
    expect(unsupportedSlashGuidance("notarealcommand")).toBeNull();
  });

  test("mcp-servers is gone from both surfaces", () => {
    expect(unsupportedSlashGuidance("mcp-servers")).toBeNull();
    expect(SLASH_COMMANDS.some((c) => c.name === "mcp-servers")).toBe(false);
    expect(Object.keys(SUB_COMMANDS)).not.toContain("mcp-servers");
  });

  test("/rewind points to /resume → t (and not /workflows restore)", () => {
    const hint = unsupportedSlashGuidance("rewind");
    expect(hint).toMatch(/\/resume/);
    expect(hint).not.toMatch(/workflows restore$/);
  });
});

describe("dispatcher short-circuit for unsupported slashes", () => {
  function makeCtx(): SlashHandlerContext {
    return {
      client: {} as EngineClient,
      profile: { name: "default", engine_url: "http://localhost:3000" } as ResolvedProfile,
      session: {
        conversationId: null,
        status: "idle",
        messages: [],
        toolCalls: [],
        usage: null,
      } as unknown as SkSessionState,
      setConversationId: () => {},
      allowedPermissions: [],
    };
  }

  test("/agents short-circuits with the guidance message", async () => {
    const out = await handleSlash("agents", [], makeCtx());
    expect(out).toMatch(/^\/agents /);
    expect(out).toMatch(/no subagent routing/);
  });

  test("a registered slash is NOT shadowed by the guidance map", async () => {
    const setConversationId = mock((_id: string | null) => {});
    const ctx: SlashHandlerContext = {
      ...makeCtx(),
      setConversationId,
    };
    const out = await handleSlash("clear", [], ctx);
    expect(out).toBe("session cleared");
    expect(setConversationId.mock.calls.length).toBe(1);
  });
});
