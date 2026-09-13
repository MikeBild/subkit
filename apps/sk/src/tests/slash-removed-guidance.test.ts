// Removed-slash guidance map.
// Asserts:
//   * agentic-coding slashes return the rationale message
//   * collapsed-into-hub slashes return the new-home hint
//   * unknown-but-not-mapped slashes return undefined (legacy behavior)
//   * the dispatcher integration short-circuits before unknown handlers
//     would have produced a generic banner.

import type { SkSessionState } from "@cli-core/index.ts";
import { describe, expect, mock, test } from "bun:test";

import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { SUB_COMMANDS } from "../index.ts";
import { removedSlashGuidance } from "../repl/slash/dispatcher.ts";
import { handleSlash, type SlashHandlerContext } from "../repl/slash/handler.ts";
import { SLASH_COMMANDS } from "../slash.ts";

describe("removedSlashGuidance map", () => {
  test("returns the agentic-coding rationale for /agents", () => {
    const hint = removedSlashGuidance("agents");
    expect(hint).toMatch(/no subagent routing/);
    expect(hint).toMatch(/Skills/);
    expect(hint).toMatch(/Knowledge Sources/);
  });

  // /health, /preview, /restore are still-registered slashes today;
  // the removed-slash guidance map only covers actually-deleted slashes
  // (the install-* per-service shims) plus permanent agentic-coding
  // redirects that subkit never ships.
  test("does NOT return guidance for still-registered slashes", () => {
    expect(removedSlashGuidance("health")).toBeNull();
    expect(removedSlashGuidance("preview")).toBeNull();
    expect(removedSlashGuidance("restore")).toBeNull();
  });

  test("covers every install-* per-service shim", () => {
    for (const svc of [
      "install-slack",
      "install-teams",
      "install-github",
      "install-google-workspace",
      "install-salesforce",
      "install-jira",
      "install-hubspot",
    ]) {
      const hint = removedSlashGuidance(svc);
      expect(hint).toMatch(/`\/install`/);
    }
  });

  test("returns null for an unmapped name", () => {
    expect(removedSlashGuidance("notarealcommand")).toBeNull();
  });

  // An external MCP server is a connector whose driver is `mcp`; the
  // separate registry it used to have is gone from every surface. A
  // command that half-exists — a slash that still redirects to a CLI verb
  // nobody can run, or a verb whose slash vanished — is worse than either
  // outcome, so both halves are asserted together.
  test("mcp-servers is gone from both surfaces, and the slash says where to go", () => {
    const hint = removedSlashGuidance("mcp-servers");
    expect(hint).toContain("/connectors");
    expect(hint).toContain("sk connectors");
    expect(SLASH_COMMANDS.some((c) => c.name === "mcp-servers")).toBe(false);
    expect(Object.keys(SUB_COMMANDS)).not.toContain("mcp-servers");
  });

  test("/rewind points to /resume → t (and not /workflows restore)", () => {
    const hint = removedSlashGuidance("rewind");
    expect(hint).toMatch(/\/resume/);
    expect(hint).not.toMatch(/workflows restore$/);
  });
});

describe("dispatcher short-circuit for removed slashes", () => {
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

  test("/install-slack short-circuits to the unified `/install` picker", async () => {
    const out = await handleSlash("install-slack", [], makeCtx());
    expect(out).toMatch(/^\/install-slack /);
    expect(out).toContain("/install");
  });

  test("/mcp-servers short-circuits to the connector surface", async () => {
    const out = await handleSlash("mcp-servers", [], makeCtx());
    expect(out).toMatch(/^\/mcp-servers /);
    expect(out).toContain("/connectors");
  });

  test("a registered slash is NOT shadowed by the guidance map", async () => {
    // /clear is a registered local slash; it must NOT pick up guidance.
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
