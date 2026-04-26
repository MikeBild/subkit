// PR11/PR12 — auto-persist on confirmation.
//
// When the LLM emits `ask_user_form` or `ask_user_confirm` with a
// `commit_intent`, the harness applies the proposed write atomically
// after `respondElicitation` resolves the carrier. The LLM's next
// turn sees a synthetic tool result with `source: "harness_auto_persist"`,
// so the loop never has to call `save_connector_draft` itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  credentials,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
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
  ctx = await createTestDb("auto_persist");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-ap", display_name: "T-AP" })
    .returning();
  tenant_id = t!.id;
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
      validation: validateConnectorDraft(baseDraft.connector ?? null),
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

async function seedConversationWithDraft(slug: string): Promise<{
  conversation_id: string;
  draft: DraftDocument;
}> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  const draft = readyDraft(slug);
  await appendSnapshot(tenant_id, conv!.id, draft, ctx.db);
  return { conversation_id: conv!.id, draft };
}

async function createCarrierElicitation(p: {
  conversation_id: string;
  tool_name: "ask_user_form" | "ask_user_confirm";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}): Promise<{ id: string; tool_name: string; input: unknown }> {
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
  if (!row) throw new Error("failed to insert elicitation");
  return { id: row.id, tool_name: row.tool_name, input: row.input };
}

describe("auto-persist on confirmation — save_connector_draft", () => {
  test("ask_user_form submit with commit_intent persists connector + credential atomically", async () => {
    const { conversation_id } = await seedConversationWithDraft("ap-bearer");
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Bearer token?",
        fields: [{ name: "token", label: "Token", type: "password", sensitive: true }],
        commit_intent: {
          kind: "save_connector_draft",
          payload: {
            credential: { mode: "bearer" },
            environment: "dev",
          },
          description: "Save the connector with this bearer token",
        },
      },
      output: { values: { token: "operator-secret-bearer" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { values: { token: "operator-secret-bearer" } },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("save_connector_draft");
    expect(dispatch.synthetic_result?.source).toBe("harness_auto_persist");

    // Connector row exists.
    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "ap-bearer")));
    expect(conn).toHaveLength(1);

    // Credential row exists.
    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(1);
    expect(cred[0]!.mode).toBe("bearer");

    // Audit row tagged with reason=auto_persist_on_confirmation.
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenant_id));
    const autoPersistRows = audit.filter((r) =>
      (r.reason ?? "").includes("auto_persist_on_confirmation"),
    );
    expect(autoPersistRows.length).toBeGreaterThanOrEqual(1);
    const harnessAudit = autoPersistRows.find(
      (r) =>
        typeof r.metadata === "object" &&
        r.metadata !== null &&
        (r.metadata as Record<string, unknown>).commit_intent_kind === "save_connector_draft",
    );
    expect(harnessAudit).toBeDefined();

    // Synthetic tool-call row injected with source=harness_auto_persist.
    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("save_connector_draft");
    const callOutput = calls[0]!.output as Record<string, unknown>;
    expect(callOutput.source).toBe("harness_auto_persist");
    expect(callOutput.ok).toBe(true);

    // Synthetic tool message in the timeline.
    const msgs = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, conversation_id));
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const toolMsgContent = toolMsg!.content as Record<string, unknown>;
    expect(toolMsgContent._harness_auto_persist).toBe(true);
  });
});
