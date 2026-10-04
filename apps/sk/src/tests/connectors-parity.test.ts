import { describe, expect, mock, test } from "bun:test";
import type { SkSessionState } from "@cli-core/index.ts";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import type { SlashHandlerContext } from "../repl/slash/handler.ts";
import { dispatchAdminListSlash } from "../repl/slash/handlers/admin-lists.ts";

function makeCtx(client: EngineClient): SlashHandlerContext {
  return {
    client,
    profile: { name: "default", engine_url: "http://localhost:3000" } as ResolvedProfile,
    session: {
      conversationId: null,
      status: "idle",
      messages: [],
      toolCalls: [],
      usage: null,
    } as unknown as SkSessionState,
    setConversationId: () => {},
    allowedPermissions: ["connector:read"],
  };
}

describe("connectors parity — slash and CLI hit listConnectors with the same args", () => {
  test("/connectors slash invokes client.listConnectors({ limit: 20 })", async () => {
    const listConnectors = mock(async () => ({
      items: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          display_name: "Stripe Production",
          slug: "stripe-prod",
        },
      ],
    }));
    const client = { listConnectors } as unknown as EngineClient;
    const result = await dispatchAdminListSlash("connectors", makeCtx(client));
    expect(listConnectors.mock.calls.length).toBe(1);
    const args0 = listConnectors.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args0[0]).toEqual({ limit: 20 });
    const out = typeof result === "string" ? result : JSON.stringify(result);
    expect(out).toContain("Stripe Production");
    expect(out).toContain("11111111");
  });

  test("CLI command source declares a listCommand that hits client.listConnectors", () => {
    const cliSrc = require("node:fs").readFileSync(
      "apps/sk/src/commands/connectors.ts",
      "utf8",
    ) as string;
    expect(cliSrc).toMatch(/const listCommand = defineCommand/);
    expect(cliSrc).toMatch(/client\.listConnectors\(/);
  });

  test("audit invariant: both paths route through the engine's /v1/connectors", () => {
    const slashSrc = require("node:fs").readFileSync(
      "apps/sk/src/repl/slash/handlers/admin-lists.ts",
      "utf8",
    ) as string;
    const cliSrc = require("node:fs").readFileSync(
      "apps/sk/src/commands/connectors.ts",
      "utf8",
    ) as string;
    expect(slashSrc).toMatch(/client\.listConnectors\b/);
    expect(cliSrc).toMatch(/client\.listConnectors\b/);
    expect(slashSrc).not.toMatch(/fetch\s*\(\s*["']https?:/);
    expect(cliSrc).not.toMatch(/fetch\s*\(\s*["']https?:/);
  });
});
