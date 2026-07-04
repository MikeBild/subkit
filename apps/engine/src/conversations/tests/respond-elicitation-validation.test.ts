// Integration tests for respondElicitation server-side answer validation.
//
// What's covered:
//   - A pending ask_user_form elicitation with a required field:
//       respond with empty values → throws ElicitationValidationError with
//         field_errors naming the field AND pending_elicitation.input
//         whose matching field carries `error_message`
//       the row stays `pending` (row is the re-prompt, no state transition)
//   - Respond again with a valid value → no validation error is thrown
//     (call gets past validation; the resumed loop runs via mock LLM and
//      the row is resolved)
//
// Uses a real disposable Postgres via createTestDb. The LLM provider is
// mocked via the mock provider (LLM_PROVIDER=mock). No real LLM calls.

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

/** Create a fresh active conversation and return its id. */
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

    // Directly create an ask_user_form elicitation with a required field.
    // Using createElicitation avoids going through the LLM loop.
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

    // Plan the mock LLM so that IF the loop runs (after a successful
    // respond) it does not try to call a real model.
    getMockProvider().setConversePlan(conversation_id, []);

    // Respond with an empty values map — required field missing.
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

    // Must have thrown the validation error
    expect(threw).toBeInstanceOf(ElicitationValidationError);

    // field_errors must name the required field
    const fieldNames = threw!.field_errors.map((e) => e.name);
    expect(fieldNames).toContain("api_key");

    // pending_elicitation.input must carry error_message on the api_key field
    const pendingInput = threw!.pending_elicitation.input as {
      fields: Array<{ name: string; error_message?: string }>;
    };
    const apiKeyField = pendingInput.fields.find((f) => f.name === "api_key");
    expect(apiKeyField).toBeDefined();
    expect(apiKeyField?.error_message).toBeDefined();
    expect(typeof apiKeyField?.error_message).toBe("string");

    // The row must still be pending — the validation failure must not resolve it
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

    // Plan the mock LLM with an empty turn so the resumed loop exits cleanly
    // without any tool calls (no state changes required for this test).
    getMockProvider().setConversePlan(conversation_id, []);

    // Respond with a valid value — validation must pass without throwing
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

    // No ElicitationValidationError thrown — validation passed
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

    // Respond with a decline — required field missing but decline must pass
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

    // Decline must never hit validation error
    expect(threw).not.toBeInstanceOf(ElicitationValidationError);

    // Row must be resolved (declined)
    const rowAfter = await getElicitation(tenant_id, elicitation.id, testDb.db);
    expect(rowAfter?.status).toBe("resolved");
  });
});
