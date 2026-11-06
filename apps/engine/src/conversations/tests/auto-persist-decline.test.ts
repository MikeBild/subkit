import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  connectors,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  credentials,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot } from "../draft.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("auto_persist_decline");
  tenant_id = (await seedTenant(ctx.db, { slug: "t-apd", display_name: "T-APD" })).id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function readyDraft(slug: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: slug,
      slug,
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.example.test",
    },
    workflow: { name: "", steps: [] },
  };
  const validated = withConnectorValidation(
    withConnectorInspection(baseDraft),
    {
      ...baseDraft.connector,
      validation: validateConnectorDraft(baseDraft.connector ?? null, []),
    },
    true,
    "Connector draft validated.",
  );
  return withConnectorProbe(
    validated,
    {
      ...validated.connector,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/health",
        environment: "dev",
        status_code: 200,
        summary: "ok",
      },
    },
    true,
    "ok",
  );
}

async function seedConversationWithDraft(slug: string): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  const draft = readyDraft(slug);
  await appendSnapshot(tenant_id, conv!.id, draft, ctx.db);
  return conv!.id;
}

async function insertCarrier(p: {
  conversation_id: string;
  tool_name: "ask_user_form" | "ask_user_confirm";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}) {
  const [row] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id: p.conversation_id,
      tool_name: p.tool_name,
      summary: "test carrier",
      input: p.input,
      output: p.output,
      status: "resolved",
    })
    .returning();
  return { id: row!.id, tool_name: row!.tool_name, input: row!.input };
}

describe("auto-persist — decline path", () => {
  test("ask_user_confirm declined → no DB write, synthetic error_code=user_declined", async () => {
    const conversation_id = await seedConversationWithDraft("ap-decline");
    const elicitation = await insertCarrier({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Save the connector?",
        kind: "generic",
        commit_intent: {
          kind: "save_connector_draft",
          payload: { credential: { mode: "bearer", token: "would-be-secret" }, environment: "dev" },
          description: "Save",
        },
      },
      output: { confirmed: false },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: false },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("user_declined");
    expect(dispatch.synthetic_result?.next_best_actions).toContain("cannot_help");

    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "ap-decline")));
    expect(conn).toHaveLength(0);
    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.tenant_id, tenant_id));
    expect(cred).toHaveLength(0);

    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    const out = calls[0]!.output as Record<string, unknown>;
    expect(out.error_code).toBe("user_declined");
    expect(out.source).toBe("harness_auto_persist");
  });

  test("ask_user_confirm portal-approved {approved:true} → write gate clears (NOT user_declined)", async () => {
    const conversation_id = await seedConversationWithDraft("ap-approved");
    const elicitation = await insertCarrier({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Save the connector?",
        kind: "generic",
        commit_intent: {
          kind: "save_connector_draft",
          payload: {
            credential: { mode: "bearer", token: "would-be-secret" },
            environment: "dev",
          },
          description: "Save",
        },
      },
      output: { approved: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { approved: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.error_code).not.toBe("user_declined");
    expect(dispatch.synthetic_result?.tool).toBe("save_connector_draft");
  });

  test("ask_user_form empty submission → synthetic error_code=empty_submission, no DB write", async () => {
    const conversation_id = await seedConversationWithDraft("ap-empty");
    const elicitation = await insertCarrier({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Bearer token?",
        fields: [{ name: "token", label: "Token", type: "password", sensitive: true }],
        commit_intent: {
          kind: "save_connector_draft",
          payload: { credential: { mode: "bearer" }, environment: "dev" },
          description: "Save",
        },
      },
      output: { values: { token: "" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { values: { token: "" } },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("empty_submission");

    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "ap-empty")));
    expect(conn).toHaveLength(0);
  });
});

test("form cancellation with otherwise complete values never commits its intent", async () => {
  const conversation_id = await seedConversationWithDraft("cancel-complete-form");
  const output = { declined: true, values: { token: "would-be-secret" } };
  const elicitation = await insertCarrier({
    conversation_id,
    tool_name: "ask_user_form",
    output,
    input: {
      question: "Save?",
      fields: [{ name: "token", label: "Token", type: "text" }],
      commit_intent: {
        kind: "save_connector_draft",
        payload: { credential: { mode: "bearer", token: "would-be-secret" }, environment: "dev" },
        description: "Save",
      },
    },
  });
  const result = await maybeAutoPersistFromElicitation({
    tenant_id,
    conversation_id,
    actor_id: null,
    answer_actor: TEST_HUMAN_ANSWER,
    elicitation_output: output,
    elicitation,
    db: ctx.db,
  });
  expect(result.synthetic_result?.error_code).toBe("user_declined");
  const saved = await ctx.db
    .select()
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "cancel-complete-form")));
  expect(saved).toHaveLength(0);
});
