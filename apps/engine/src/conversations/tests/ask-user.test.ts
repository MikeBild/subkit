// Schema contract tests for the ask_user_* tool family. Guards the input
// shapes we stream to the client in the `tool_call_start` frame and persist
// into `conversation_elicitations.input`.
//
// The `connector_auth_unset` gate tests at the bottom exercise the RC-4
// gate in `ask_user_form.execute`. The pure gate path needs no DB; the
// companion (gate passes → normal pause) is integration and uses a real DB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { appendSnapshot } from "../draft.ts";
import {
  askUserChoiceTool,
  askUserConfirmTool,
  askUserFormTool,
  askUserMultiTool,
  askUserTextTool,
} from "../tools/ask-user/index.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let integrationDb: TestDb | null = null;
let integrationTenantId: string | null = null;

beforeAll(async () => {
  integrationDb = await createTestDb("ask_user_form_gate");
  const [t] = await integrationDb.db
    .insert(tenants)
    .values({ slug: "t-auf-gate", display_name: "T-AUF-GATE" })
    .returning();
  integrationTenantId = t!.id;
});

afterAll(async () => {
  if (integrationDb) await integrationDb.cleanup();
});

describe("ask_user_choice schema", () => {
  test("accepts a valid question + options", () => {
    const parsed = askUserChoiceTool.inputSchema.safeParse({
      question: "Which environment?",
      options: [
        { value: "dev", label: "Development" },
        { value: "prod", label: "Production", description: "cannot be undone" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects fewer than two options", () => {
    const parsed = askUserChoiceTool.inputSchema.safeParse({
      question: "pick?",
      options: [{ value: "only", label: "only" }],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects missing question", () => {
    const parsed = askUserChoiceTool.inputSchema.safeParse({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ask_user_multi schema", () => {
  test("accepts min/max bounds", () => {
    const parsed = askUserMultiTool.inputSchema.safeParse({
      question: "Which skills?",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
      min: 1,
      max: 2,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ask_user_text schema", () => {
  test("accepts plain question", () => {
    const parsed = askUserTextTool.inputSchema.safeParse({ question: "API key?" });
    expect(parsed.success).toBe(true);
  });

  test("accepts multiline + placeholder + validation_regex", () => {
    const parsed = askUserTextTool.inputSchema.safeParse({
      question: "Paste your config",
      placeholder: "{...}",
      multiline: true,
      validation_regex: "^\\{.*\\}$",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ask_user_form schema", () => {
  test("accepts a form with typed fields", () => {
    const parsed = askUserFormTool.inputSchema.safeParse({
      question: "Connector credentials",
      fields: [
        { name: "key", label: "API key", type: "text", required: true },
        { name: "count", label: "Count", type: "number" },
        {
          name: "env",
          label: "Environment",
          type: "select",
          options: [
            { value: "dev", label: "dev" },
            { value: "prod", label: "prod" },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects empty fields array", () => {
    const parsed = askUserFormTool.inputSchema.safeParse({
      question: "nothing",
      fields: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ask_user_confirm schema", () => {
  test("accepts save_workflow_draft kind with diff", () => {
    const parsed = askUserConfirmTool.inputSchema.safeParse({
      question: "Commit this workflow?",
      kind: "save_workflow_draft",
      summary: "Creates workflow `orders-sync`",
      diff: { before: null, after: { name: "orders-sync" } },
    });
    expect(parsed.success).toBe(true);
  });

  test("defaults kind to generic when omitted", () => {
    const parsed = askUserConfirmTool.inputSchema.safeParse({
      question: "Proceed?",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { kind: string }).kind).toBe("generic");
    }
  });

  test("accepts destructive + default hints", () => {
    const parsed = askUserConfirmTool.inputSchema.safeParse({
      question: "Delete?",
      destructive: true,
      default: "reject",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("askUser tool identity", () => {
  test("each tool exposes a stable name", () => {
    expect(askUserChoiceTool.name).toBe("ask_user_choice");
    expect(askUserMultiTool.name).toBe("ask_user_multi");
    expect(askUserTextTool.name).toBe("ask_user_text");
    expect(askUserFormTool.name).toBe("ask_user_form");
    expect(askUserConfirmTool.name).toBe("ask_user_confirm");
  });
});

// RC-4: ask_user_form gate — sensitive field + active connector draft with
// auth_type null/undefined → { ok:false, error_code:"connector_auth_unset" }.

import type { ConnectorDraftDocument } from "../types.ts";

/** Minimal context carrying a draft with the given connector shape.
 *  The gate fires before any DB call, so the DB is intentionally absent. */
function buildGatedCtx(connector: ConnectorDraftDocument): ToolContext {
  const draft: DraftDocument = {
    mode: "connector_authoring",
    connector,
    workflow: { name: "", steps: [] },
  };
  return {
    db: null as never,
    tenant_id: "t-stub",
    conversation_id: "c-stub",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: null as never,
    getDraft: () => draft,
    setDraft: async () => {},
  };
}

describe("ask_user_form — connector_auth_unset gate (RC-4)", () => {
  // auth_type omitted (undefined) — the gate uses `== null` so both
  // undefined and null trigger it. We test it here with the property absent.
  test("password field + connector draft with auth_type unset → connector_auth_unset", async () => {
    const ctx = buildGatedCtx({
      name: "test",
      slug: "test",
      driver: "http",
      environment: "dev",
      // auth_type intentionally absent → undefined at runtime.
    });
    const result = await askUserFormTool.execute(ctx, {
      question: "Enter your API key",
      fields: [{ name: "token", label: "API key", type: "password" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("connector_auth_unset");
      expect(result.next_best_actions).toContain("update_connector_draft");
    }
  });

  // auth_type set to null at runtime (deserialized from JSON).
  // The gate checks `== null` so both undefined and null fire it.
  // Cast through unknown to thread null past TypeScript's strict optional check —
  // the gate is a runtime guard that must handle JSON-deserialized nulls too.
  test("sensitive:true field + connector draft with auth_type null → connector_auth_unset", async () => {
    const nullAuthConnector = {
      name: "test",
      slug: "test",
      driver: "http",
      environment: "dev",
      auth_type: null,
    };
    const ctx = buildGatedCtx(nullAuthConnector as unknown as ConnectorDraftDocument);
    const result = await askUserFormTool.execute(ctx, {
      question: "Enter your secret",
      fields: [{ name: "secret", label: "Secret", type: "text", sensitive: true }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("connector_auth_unset");
    }
  });

  // Companion: same form when auth_type IS set passes the gate.
  // The tool will call pauseForUserInput which inserts into conversation_elicitations,
  // so a real DB + conversation row is required.
  test("password field + connector draft with auth_type bearer → gate passes (pauses for input)", async () => {
    if (!integrationDb || !integrationTenantId) throw new Error("db not ready");
    const [conv] = await integrationDb.db
      .insert(conversations)
      .values({ tenant_id: integrationTenantId, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;

    const draft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "test-bearer",
        slug: "test-bearer",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(integrationTenantId, conversation_id, draft, integrationDb.db);

    const ctx: ToolContext = {
      db: integrationDb.db,
      tenant_id: integrationTenantId,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: null as never,
      getDraft: () => draft,
      setDraft: async () => {},
    };

    const result = await askUserFormTool.execute(ctx, {
      question: "Enter your bearer token",
      fields: [{ name: "token", label: "Token", type: "password" }],
    });

    // Gate must pass — no connector_auth_unset error.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause?.tool_name).toBe("ask_user_form");
    }
  });

  // Non-sensitive form fields (no password, no sensitive:true) must not trigger
  // the gate even when auth_type is unset.
  test("text field without sensitive:true + auth_type unset → gate not triggered", async () => {
    const ctx = buildGatedCtx({ name: "test", slug: "test", driver: "http", environment: "dev" });
    // No DB context — if this reaches pauseForUserInput it will throw.
    // But it should not trigger the gate so we check the result is NOT connector_auth_unset.
    let result: Awaited<ReturnType<typeof askUserFormTool.execute>> | undefined;
    try {
      result = await askUserFormTool.execute(ctx, {
        question: "What is your name?",
        fields: [{ name: "name", label: "Name", type: "text" }],
      });
    } catch {
      // The tool reached pauseForUserInput (past the gate), which threw due to no DB.
      // That means the gate correctly did not fire. This is the expected path.
      return;
    }
    // If we get here without throwing, the gate should not have fired.
    if (result && !result.ok) {
      expect((result as { error_code?: string }).error_code).not.toBe("connector_auth_unset");
    }
  });
});
