// Tests for the request_connector_reauth conversation tool.
//
// Follows the call-connector.test.ts pattern: seeds connectors via direct DB
// inserts, constructs a ToolContext via makeToolContext, and exercises the
// tool's execute() function directly — no HTTP boundary.
//
// Coverage:
//   - happy path: connector_id → ok:true, correct reauth fields returned.
//   - slug resolution: slug → ok:true (resolved to connector_id internally).
//   - neither id nor slug → invalid_input.
//   - unknown slug → connector_not_found.
//   - unknown connector_id (UUID not in DB) → connector_not_found.
//   - needs_reauth flag reflected in data.needs_reauth.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "./index.ts";
import { requestConnectorReauthTool } from "./request-connector-reauth.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("req_reauth");
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function seedConnector(opts: {
  slug: string;
  needs_reauth?: boolean;
}): Promise<{ connector_id: string }> {
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug: opts.slug,
      display_name: opts.slug,
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://example.test",
      config: {},
      needs_reauth: opts.needs_reauth ?? false,
    })
    .returning();
  if (!c) throw new Error("seed connector failed");
  return { connector_id: c.id };
}

function makeToolContext(actorId: string | null = ctx.user_id): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: actorId,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: actorId,
      actor_type: actorId ? "user" : "system",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

// ---------------------------------------------------------------------------
// happy paths
// ---------------------------------------------------------------------------

describe("request_connector_reauth — happy path", () => {
  test("connector_id → ok:true with reauth fields", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-happy-id" });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), { connector_id });

    expect(result.ok).toBe(true);
    const data = result.data as {
      connector: string;
      method: string;
      reauth_url: string | null;
      instructions: string;
      needs_reauth: boolean;
    };
    expect(typeof data.connector).toBe("string");
    expect(data.method === "oauth2" || data.method === "portal_setup").toBe(true);
    expect(typeof data.instructions).toBe("string");
    expect(data.instructions.length).toBeGreaterThan(0);
    // needs_reauth reflects the current DB state (false for a healthy connector).
    expect(data.needs_reauth).toBe(false);
  });

  test("slug → ok:true (resolved to connector_id internally)", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-happy-slug" });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), {
      slug: "rr-happy-slug",
    });

    expect(result.ok).toBe(true);
    const data = result.data as { connector: string };
    expect(data.connector).toBe("rr-happy-slug");
    void connector_id; // verified via slug match
  });

  test("needs_reauth=true is reflected in the response data", async () => {
    const { connector_id } = await seedConnector({ slug: "rr-flagged", needs_reauth: true });

    const result = await requestConnectorReauthTool.execute(makeToolContext(), { connector_id });

    expect(result.ok).toBe(true);
    const data = result.data as { needs_reauth: boolean };
    expect(data.needs_reauth).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error envelopes
// ---------------------------------------------------------------------------

type ErrorResult = { ok: false; error_code?: string; message?: string };

describe("request_connector_reauth — error envelopes", () => {
  test("neither connector_id nor slug → invalid_input", async () => {
    const result = (await requestConnectorReauthTool.execute(makeToolContext(), {})) as ErrorResult;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("invalid_input");
    expect(typeof result.message).toBe("string");
  });

  test("unknown slug → connector_not_found", async () => {
    const result = (await requestConnectorReauthTool.execute(makeToolContext(), {
      slug: "no-such-connector-slug-xyz",
    })) as ErrorResult;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("connector_not_found");
  });

  test("unknown connector_id (valid UUID not in DB) → connector_not_found", async () => {
    const result = (await requestConnectorReauthTool.execute(makeToolContext(), {
      connector_id: crypto.randomUUID(), // allow-random: valid UUID not in DB
    })) as ErrorResult;

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("connector_not_found");
  });
});
