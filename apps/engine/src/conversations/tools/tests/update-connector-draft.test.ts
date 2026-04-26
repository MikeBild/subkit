// Unit tests for update_connector_draft credential-shape rejection.
//
// Credential-shape detection fires BEFORE any DB or draft mutation, so
// rejection tests need only a minimal mock context. Clean-pass tests
// exercise the full tool including template resolution and require a
// live DB (createTestDb).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { updateConnectorDraftTool } from "../update-connector-draft.ts";

// ---------------------------------------------------------------------------
// Pure unit tests — credential-shape rejection (no DB required)
// ---------------------------------------------------------------------------

// A minimal stub: only the fields the rejection path touches.
const stubCtx = {
  conversation_id: "test-conv",
  tenant_id: "test-tenant",
  actor_id: null,
  connector_id: null,
  workflow_id: null,
  getDraft: () => createEmptyDraftDocument(),
  setDraft: async () => {},
} as unknown as ToolContext;

describe("update_connector_draft — credential-shape rejection", () => {
  it("rejects a top-level credential key in config", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { credential: "some-value" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
      expect(result.message).toContain("ask_user_form");
      expect(result.next_best_actions).toEqual(
        expect.arrayContaining(["ask_user_form", "save_connector_draft"]),
      );
    }
  });

  it("rejects a nested token key under auth", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { auth: { token: "abc123" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a DigitalOcean PAT token-shape value at any key", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { whatever: "dop_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a GitHub PAT token-shape value", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { mykey: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a JWT-shaped value", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { session: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects an api_key field in config", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { api_key: "not-blank" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a password field in config", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { password: "hunter2" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects Authorization as a static_headers key (static_headers.Authorization matches key pattern)", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { static_headers: { Authorization: "static" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("does not mutate the draft on rejection", async () => {
    const emptyDraft = createEmptyDraftDocument();
    let storedDraft = emptyDraft;
    const ctx: ToolContext = {
      ...stubCtx,
      getDraft: () => emptyDraft,
      setDraft: async (next: DraftDocument) => {
        storedDraft = next;
      },
    };
    await updateConnectorDraftTool.execute(ctx, {
      config: { token: "secret" },
    });
    // setDraft was NOT called — draft remains the original empty document.
    expect(storedDraft).toBe(emptyDraft);
  });

  it("surfaces the structured error envelope shape", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { secret: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // error_code is machine-readable, message is human-readable.
      expect(typeof result.error_code).toBe("string");
      expect(typeof result.message).toBe("string");
      expect(Array.isArray(result.next_best_actions)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — clean updates require DB + template resolution
// ---------------------------------------------------------------------------

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("update_connector_draft");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function makeCtx() {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "update-connector-draft-test",
    },
    ctx.testDb.db,
  );
  let draft: DraftDocument = createEmptyDraftDocument();
  const base: ToolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as never,
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  };
  return { base, getDraft: () => draft };
}

describe("update_connector_draft — clean updates pass", () => {
  it("accepts a clean base_url update without config", async () => {
    const { base } = await makeCtx();
    const result = await updateConnectorDraftTool.execute(base, {
      name: "My API",
      driver: "http",
      environment: "dev",
      base_url: "https://api.example.com",
      auth_type: "none",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a config with only non-sensitive keys", async () => {
    const { base } = await makeCtx();
    const result = await updateConnectorDraftTool.execute(base, {
      config: { base_url: "https://api.example.com", timeout_ms: 5000, retries: 3 },
    });
    expect(result.ok).toBe(true);
  });

  it("mutates the draft on a clean update", async () => {
    const { base, getDraft } = await makeCtx();
    await updateConnectorDraftTool.execute(base, {
      name: "Updated Name",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    });
    expect(getDraft().connector?.name).toBe("Updated Name");
  });
});
