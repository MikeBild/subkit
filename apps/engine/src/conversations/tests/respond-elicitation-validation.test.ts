import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationMessages,
  conversations,
  conversationToolCalls,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createElicitation, getElicitation } from "../elicitations.ts";
import { PlaybookDocumentSchema } from "../playbook-contract.ts";
import { ElicitationValidationError } from "../service/elicit.ts";
import { respondElicitationForTest } from "./setup.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  testDb = await createTestDb("respond_elicitation_validation");

  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-rev", display_name: "T-REV" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function freshConversation(): Promise<string> {
  const [conv] = await testDb.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conversation failed");
  return conv.id;
}

describe("respondElicitation — validation re-prompt", () => {
  test("empty values for a required form field throws ElicitationValidationError and leaves the row pending", async () => {
    const conversation_id = await freshConversation();

    const elicitation = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_form",
        summary: "Enter your API credentials",
        input: {
          question: "API Credentials",
          fields: [
            { name: "api_key", label: "API Key", type: "text", required: true },
            { name: "region", label: "Region", type: "text", required: false },
          ],
        },
        actor_id: null,
      },
      testDb.db,
    );

    getMockProvider().setConversePlan(conversation_id, []);

    let threw: ElicitationValidationError | undefined;
    try {
      await respondElicitationForTest(
        {
          tenant_id,
          conversation_id,
          elicitation_id: elicitation.id,
          actor_id: null,
          output: { values: {} },
        },
        testDb.db,
      );
    } catch (err) {
      if (err instanceof ElicitationValidationError) {
        threw = err;
      } else {
        throw err;
      }
    }

    expect(threw).toBeInstanceOf(ElicitationValidationError);

    const fieldNames = threw!.field_errors.map((e) => e.name);
    expect(fieldNames).toContain("api_key");

    const pendingInput = threw!.pending_elicitation.input as {
      fields: Array<{ name: string; error_message?: string }>;
    };
    const apiKeyField = pendingInput.fields.find((f) => f.name === "api_key");
    expect(apiKeyField).toBeDefined();
    expect(apiKeyField?.error_message).toBeDefined();
    expect(typeof apiKeyField?.error_message).toBe("string");

    const rowAfter = await getElicitation(tenant_id, elicitation.id, testDb.db);
    expect(rowAfter?.status).toBe("pending");
  });

  test("valid answer for a required form field does NOT throw a validation error", async () => {
    const conversation_id = await freshConversation();

    const elicitation = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_form",
        summary: "Enter your name",
        input: {
          question: "Name",
          fields: [{ name: "name", label: "Name", type: "text", required: true }],
        },
        actor_id: null,
      },
      testDb.db,
    );

    getMockProvider().setConversePlan(conversation_id, []);

    let threw: unknown;
    try {
      await respondElicitationForTest(
        {
          tenant_id,
          conversation_id,
          elicitation_id: elicitation.id,
          actor_id: null,
          output: { values: { name: "Alice" } },
        },
        testDb.db,
      );
    } catch (err) {
      threw = err;
    }

    expect(threw).not.toBeInstanceOf(ElicitationValidationError);
  });

  test("localized elicitation response keeps its locale in the returned playbook projection", async () => {
    const conversation_id = await freshConversation();
    const now = new Date().toISOString();
    const playbook = PlaybookDocumentSchema.parse({
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      evidence_fingerprints: {},
      plan: {
        title: "Review source",
        goal: "Confirm source access",
        steps: [
          {
            id: "read_source",
            label: "Read source",
            criterion: {
              kind: "resource_observed",
              resource: { type: "file", id: crypto.randomUUID() },
            },
            depends_on: [],
            evidence_ids: [],
            note: null,
            progress: "open",
            next_action: null,
          },
        ],
        cancelled: false,
        completion_step_id: null,
      },
    });
    await testDb.db
      .update(conversations)
      .set({ playbook, playbook_revision: 1 })
      .where(eq(conversations.id, conversation_id));
    await testDb.db.insert(conversationMessages).values({
      tenant_id,
      conversation_id,
      role: "user",
      content: "Please review the source access.",
    });
    const principal = {
      id: "00000000-0000-4000-8000-000000000101",
      kind: "user" as const,
      tenant_id,
      roles: ["admin"],
      provider: "test",
    };

    const elicitation = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_form",
        summary: "Enter your name",
        input: {
          question: "Name",
          fields: [{ name: "name", label: "Name", type: "text", required: true }],
        },
        actor_id: null,
      },
      testDb.db,
    );
    getMockProvider().setConversePlan(conversation_id, [
      { tool: "inspect_playbook", args: {} },
      { text: "Source review remains open." },
    ]);

    const outcome = await respondElicitationForTest(
      {
        tenant_id,
        conversation_id,
        elicitation_id: elicitation.id,
        actor_id: null,
        principal,
        locale: "en",
        output: { values: { name: "Alice" } },
      },
      testDb.db,
    );

    expect(outcome.result.status).toBe("active");
    const [inspection] = await testDb.db
      .select({ output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, tenant_id),
          eq(conversationToolCalls.conversation_id, conversation_id),
          eq(conversationToolCalls.tool, "inspect_playbook"),
        ),
      );
    const result = inspection?.output as
      | { playbook?: { steps?: Array<{ criterion?: string }> } }
      | undefined;
    expect(result?.playbook?.steps?.[0]?.criterion).toContain(
      "The referenced resource was actually read",
    );
  });

  test("decline {confirmed:false} bypasses validation and resolves the row", async () => {
    const conversation_id = await freshConversation();

    const elicitation = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_form",
        summary: "Enter your API key",
        input: {
          question: "API Key",
          fields: [{ name: "api_key", label: "API Key", type: "text", required: true }],
        },
        actor_id: null,
      },
      testDb.db,
    );

    getMockProvider().setConversePlan(conversation_id, []);

    let threw: unknown;
    try {
      await respondElicitationForTest(
        {
          tenant_id,
          conversation_id,
          elicitation_id: elicitation.id,
          actor_id: null,
          output: { confirmed: false },
        },
        testDb.db,
      );
    } catch (err) {
      threw = err;
    }

    expect(threw).not.toBeInstanceOf(ElicitationValidationError);

    const rowAfter = await getElicitation(tenant_id, elicitation.id, testDb.db);
    expect(rowAfter?.status).toBe("resolved");
  });
});
