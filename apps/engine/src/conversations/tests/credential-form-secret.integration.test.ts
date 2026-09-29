// A credential typed into the chat form reaches the connector's encrypted
// credential and nowhere else.
//
// The engine asks for a static credential with
// `ask_user_form({ name: "token", type: "password", sensitive: true })`.
// This drives that exact path in-process, as the cockpit does it:
//   1. the pending form is projected for the reader (resume summary) — the
//      masked field is there, as a definition without a value;
//   2. the operator's answer resumes the conversation (respondElicitation);
//   3. the harness writes the credential AES-256-GCM encrypted to
//      `credentials` and the plaintext appears in no other row, in no log
//      line and in no model request.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { markConnectorNeedsReauth } from "../../connectors/reauth.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import {
  auditLog,
  connectors,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  credentials,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { _resetLoggerForTests, reconfigureLogger } from "../../logging/logger.ts";
import { logRing } from "../../observability/log-ring.ts";
import { appendSnapshot } from "../draft.ts";
import { pendingPrompt } from "../resume.ts";
import { createConversation } from "../service.ts";
import { askUserFormTool } from "../tools/ask-user/form.ts";
import { ELICITATION_REDACTED_MARKER } from "../tools/ask-user/redact-answer.ts";
import { requestConnectorReauthTool } from "../tools/request-connector-reauth.ts";
import type { DraftDocument } from "../types.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
  respondElicitationForTest,
} from "./setup.ts";

// Fake, but shaped like a real vendor key so no redaction pattern gets a pass.
const SECRET = "mb_9f3c2a7e41d84b0c9a6e5f1d2b3c4a5e6f7081928374655a";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("credential_form_secret");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("chat credential form", () => {
  test("the secret is stored encrypted on the connector and persisted nowhere in plaintext", async () => {
    const db = ctx.testDb.db;
    const [connector] = await db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "metabase-secret",
        display_name: "Metabase",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: "https://metabase.example.test/api",
      })
      .returning({ id: connectors.id });
    if (!connector) throw new Error("seed connector failed");
    await markConnectorNeedsReauth(db, ctx.tenant_id, connector.id, "token_expired");

    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "metabase key" },
      db,
    );
    const conversation_id = created.conversation.id;
    let draft: DraftDocument = { workflow: { name: "", steps: [] } };
    const toolCtx = {
      db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: ctx.user_id,
      connector_id: connector.id,
      workflow_id: null,
      permission_mode: null,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        actor_type: "user",
        db,
      }),
      getDraft: () => draft,
      setDraft: async (next: DraftDocument) => {
        draft = next;
        await appendSnapshot(ctx.tenant_id, conversation_id, next, db);
      },
    };
    expect(
      (await requestConnectorReauthTool.execute(toolCtx, { connector_id: connector.id })).ok,
    ).toBe(true);
    const asked = await askUserFormTool.execute(toolCtx, {
      question: "Enter the Metabase API key",
      fields: [
        { name: "token", label: "API key", type: "password", sensitive: true, required: true },
      ],
    });
    expect(asked.ok).toBe(true);

    const [pending] = await db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id));
    if (!pending) throw new Error("no pending form");
    // (1) The reader sees the masked field — the regression was an empty prompt.
    expect(pendingPrompt(pending.input).prompt).toMatchObject({
      question: "Enter the Metabase API key",
      intent_kind: "save_connector_draft",
      fields: [{ name: "token", label: "API key", type: "password", sensitive: true }],
    });

    // (2) The operator answers; capture every log line the resume emits.
    const logged: string[] = [];
    reconfigureLogger({ level: "trace", format: "ndjson" });
    const unsubscribe = logRing.subscribe((entry) => logged.push(JSON.stringify(entry)));
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    const modelCallsBefore = getMockProvider().calls.length;
    getMockProvider().setConversePlan(conversation_id, []);
    try {
      await respondElicitationForTest(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          elicitation_id: pending.id,
          actor_id: ctx.user_id,
          output: { values: { token: SECRET } },
        },
        db,
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      unsubscribe();
      _resetLoggerForTests();
    }

    // (3a) Stored, encrypted, on the connector.
    const [stored] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.connector_id, connector.id));
    if (!stored) throw new Error("credential not stored");
    for (const column of [stored.ciphertext, stored.iv, stored.auth_tag]) {
      expect(Buffer.from(column).toString("latin1")).not.toContain(SECRET);
    }
    const decrypted = await getCredentialForConnector(ctx.tenant_id, connector.id, "dev", db);
    expect(JSON.stringify(decrypted?.value)).toContain(SECRET);

    // (3b) Everywhere else: the marker at most, never the value.
    const [answered] = await db
      .select({ output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, pending.id));
    expect(
      (answered?.output as { values?: Record<string, string> } | undefined)?.values?.token,
    ).toBe(ELICITATION_REDACTED_MARKER);
    const persisted = {
      conversation: await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversation_id)),
      messages: await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversation_id, conversation_id)),
      toolCalls: await db
        .select()
        .from(conversationToolCalls)
        .where(eq(conversationToolCalls.conversation_id, conversation_id)),
      elicitations: await db
        .select()
        .from(conversationElicitations)
        .where(eq(conversationElicitations.conversation_id, conversation_id)),
      audit: await db.select().from(auditLog).where(eq(auditLog.tenant_id, ctx.tenant_id)),
      connector: await db.select().from(connectors).where(eq(connectors.id, connector.id)),
    };
    expect(persisted.audit.length).toBeGreaterThan(0);
    for (const [where, rows] of Object.entries(persisted)) {
      expect({ where, leaked: JSON.stringify(rows).includes(SECRET) }).toEqual({
        where,
        leaked: false,
      });
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter((line) => line.includes(SECRET))).toEqual([]);
    const modelCalls = getMockProvider().calls.slice(modelCallsBefore);
    expect(JSON.stringify(modelCalls)).not.toContain(SECRET);
  }, 60_000);

  test("a form the reader cannot render is refused before anything waits on it", async () => {
    const db = ctx.testDb.db;
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "dead end" },
      db,
    );
    const conversation_id = created.conversation.id;
    const draft: DraftDocument = { workflow: { name: "", steps: [] } };
    const result = await askUserFormTool.execute(
      {
        db,
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        connector_id: null,
        workflow_id: null,
        permission_mode: null,
        engineClient: new EngineClient({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          actor_type: "user",
          db,
        }),
        getDraft: () => draft,
        setDraft: async () => {},
      },
      {
        question: "Which region?",
        fields: [
          { name: "region", label: "Region", type: "text" },
          { name: "region", label: "Region again", type: "text" },
        ],
      },
    );
    expect(result).toMatchObject({ ok: false, error_code: "form_not_renderable" });
    expect(result.pause).toBeUndefined();
    const rows = await db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id));
    expect(rows).toEqual([]);
    const [conversation] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    expect(conversation?.status).not.toBe("awaiting_input");
  }, 60_000);
});
