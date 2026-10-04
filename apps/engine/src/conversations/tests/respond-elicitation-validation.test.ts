import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createElicitation, getElicitation } from "../elicitations.ts";
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
