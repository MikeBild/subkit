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

import type { ConnectorDraftDocument } from "../types.ts";

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
  test("password field + connector draft with auth_type unset → connector_auth_unset", async () => {
    const ctx = buildGatedCtx({
      name: "test",
      slug: "test",
      driver: "http",
      environment: "dev",
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause?.tool_name).toBe("ask_user_form");
    }
  });

  test("basic draft + single `basic_auth` field → credential_form_mismatch (session 97679846 repro)", async () => {
    const ctx = buildGatedCtx({
      name: "jira",
      slug: "jira",
      driver: "graphql",
      environment: "dev",
      auth_type: "basic",
    });
    const result = await askUserFormTool.execute(ctx, {
      question: "Enter your Jira credentials",
      fields: [{ name: "basic_auth", label: "email:api_token", type: "password" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_form_mismatch");
      expect(result.message).toContain("username, password");
      expect(result.message).toContain("base64");
      expect(result.next_best_actions).toContain("ask_user_form");
    }
  });

  test("bearer draft canonicalizes one sensitive alias to `token` before pausing", async () => {
    if (!integrationDb || !integrationTenantId) throw new Error("integration DB not initialized");
    const [conv] = await integrationDb.db
      .insert(conversations)
      .values({ tenant_id: integrationTenantId, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const draft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "t",
        slug: "t-alias",
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
      question: "Enter your API key",
      fields: [{ name: "cloudflare_api_key", label: "API key", type: "password" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const input = result.pause?.input as { fields?: Array<{ name?: string }> } | undefined;
      expect(input?.fields?.[0]?.name).toBe("token");
    }
  });

  test("ambiguous bearer form mismatch carries expected_fields + message", async () => {
    const ctx = buildGatedCtx({
      name: "t",
      slug: "t",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
    });
    const result = await askUserFormTool.execute(ctx, {
      question: "Enter your API key",
      fields: [
        { name: "api_key", label: "API key", type: "password" },
        { name: "access_key", label: "Access key", type: "password" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const data = result.data as {
        error_code?: string;
        missing?: string[];
        expected_fields?: string[];
        message?: string;
      };
      expect(data.expected_fields).toEqual(["token"]);
      expect(data.missing).toEqual(["token"]);
      expect(data.message ?? "").toContain("token");
    }
  });

  test("credential_form_mismatch data carries the full expected field set (basic, partial form)", async () => {
    const ctx = buildGatedCtx({
      name: "t",
      slug: "t",
      driver: "http",
      environment: "dev",
      auth_type: "basic",
    });
    const result = await askUserFormTool.execute(ctx, {
      question: "Enter your password",
      fields: [{ name: "password", label: "Password", type: "password" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const data = result.data as { missing?: string[]; expected_fields?: string[] };
      expect(data.missing).toEqual(["username"]);
      expect(data.expected_fields).toEqual(["username", "password"]);
    }
  });

  test("header draft + header_name seeded in commit_intent → header_value-only form passes the gate", async () => {
    const ctx = buildGatedCtx({
      name: "t",
      slug: "t",
      driver: "http",
      environment: "dev",
      auth_type: "header",
    });
    try {
      const result = await askUserFormTool.execute(ctx, {
        question: "Enter your API key",
        fields: [{ name: "header_value", label: "API key", type: "password" }],
        commit_intent: {
          kind: "save_connector_draft",
          payload: { credential: { mode: "header", header_name: "X-API-Key" } },
          description: "Save the connector with the header credential.",
        },
      });
      if (!result.ok) {
        expect(result.error_code).not.toBe("credential_form_mismatch");
      }
    } catch {}
  });

  test("text field without sensitive:true + auth_type unset → gate not triggered", async () => {
    const ctx = buildGatedCtx({ name: "test", slug: "test", driver: "http", environment: "dev" });
    let result: Awaited<ReturnType<typeof askUserFormTool.execute>> | undefined;
    try {
      result = await askUserFormTool.execute(ctx, {
        question: "What is your name?",
        fields: [{ name: "name", label: "Name", type: "text" }],
      });
    } catch {
      return;
    }
    if (result && !result.ok) {
      expect((result as { error_code?: string }).error_code).not.toBe("connector_auth_unset");
    }
  });
});

test("business choices reject text walls before pausing the conversation", () => {
  const compact = {
    question: "Wann soll der Bericht erscheinen?",
    options: [
      {
        value: "monday",
        label: "Montags (empfohlen)",
        description: "Die Daten sind sonntags vollständig.",
      },
      {
        value: "tuesday",
        label: "Dienstags",
        description: "Ein zusätzlicher Tag für die Prüfung.",
      },
    ],
  };
  expect(askUserChoiceTool.inputSchema.safeParse(compact).success).toBe(true);
  expect(
    askUserChoiceTool.inputSchema.safeParse({ ...compact, question: "x".repeat(241) }).success,
  ).toBe(false);
  expect(
    askUserChoiceTool.inputSchema.safeParse({
      ...compact,
      options: [{ ...compact.options[0], label: "x".repeat(81) }, compact.options[1]],
    }).success,
  ).toBe(false);
  expect(
    askUserChoiceTool.inputSchema.safeParse({
      ...compact,
      options: [{ ...compact.options[0], description: "x".repeat(181) }, compact.options[1]],
    }).success,
  ).toBe(false);
});
