// `createElicitation` must stamp the expiry that matches whatever capability
// actually bounds the prompt.
//
// The sweep selects on `expires_at` alone, so this value IS the bound. An
// approval-backed confirm that inherits the 7-day human window would sit pending
// for a week after its 15-minute approval died — the conversation wedged in
// `awaiting_input` exactly as before, only slower. Asserting the column is
// merely non-null does not catch that; these tests assert the VALUE.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversationElicitations, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { APPROVAL_TTL_MS } from "../../tools/approval.ts";
import { DRAFT_CREDENTIAL_SETUP_KIND } from "../draft-credential-setup.ts";
import { createElicitation, ELICITATION_HUMAN_TTL_MS } from "../elicitations.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("elicitation_expiry_stamp");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-ees", display_name: "T-EES" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function freshConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  return conv!.id;
}

/** Milliseconds between the row's own created_at and expires_at, i.e. the bound
 *  the sweep will actually honour. */
async function stampedWindowMs(id: string): Promise<number> {
  const [row] = await ctx.db
    .select({
      created_at: conversationElicitations.created_at,
      expires_at: conversationElicitations.expires_at,
    })
    .from(conversationElicitations)
    .where(
      and(eq(conversationElicitations.tenant_id, tenant_id), eq(conversationElicitations.id, id)),
    );
  if (!row) throw new Error("elicitation vanished");
  return row.expires_at.getTime() - row.created_at.getTime();
}

describe("createElicitation stamps the bounding expiry", () => {
  test("an approval-backed confirm gets the APPROVAL window, not the human one", async () => {
    const conversation_id = await freshConversation();
    const row = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_confirm",
        summary: "Confirm create_knowledge_source",
        input: {
          kind: "external_write",
          question: "Policy requires confirmation before running create_knowledge_source. Proceed?",
          commit_intent: {
            kind: "execute_confirmed_tool_call",
            payload: {
              tool: "create_knowledge_source",
              approval_id: "3ca73ebc-f99b-4071-9679-a901f84469f6",
            },
            description: "Run it with the arguments the operator is approving.",
          },
        },
        actor_id: null,
      },
      ctx.db,
    );

    const windowMs = await stampedWindowMs(row.id);
    // Allow a couple of seconds of clock/round-trip slack, but nothing near the
    // 7-day human window — that difference is the whole bug.
    expect(windowMs).toBeGreaterThan(APPROVAL_TTL_MS - 10_000);
    expect(windowMs).toBeLessThan(APPROVAL_TTL_MS + 10_000);
    expect(windowMs).toBeLessThan(ELICITATION_HUMAN_TTL_MS / 100);
  });

  test("a draft-credential prompt gets the grant's own embedded expiry", async () => {
    const conversation_id = await freshConversation();
    const embedded = new Date(Date.now() + 10 * 60_000); // allow-wall-clock
    const row = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_form",
        summary: "Enter the credential",
        input: {
          kind: DRAFT_CREDENTIAL_SETUP_KIND,
          connector_slug: "acme",
          setup_url: "https://engine.test/v1/connector-drafts/x/credentials/setup?grant=sksg_y",
          expires_at: embedded.toISOString(),
        },
        actor_id: null,
      },
      ctx.db,
    );

    const [stored] = await ctx.db
      .select({ expires_at: conversationElicitations.expires_at })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, row.id));
    expect(stored?.expires_at.toISOString()).toBe(embedded.toISOString());
  });

  test("a plain prompt gets the human window — bounded, but generous", async () => {
    const conversation_id = await freshConversation();
    const row = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "What should the report be called?",
        input: { kind: "text", question: "What should the report be called?" },
        actor_id: null,
      },
      ctx.db,
    );

    const windowMs = await stampedWindowMs(row.id);
    expect(windowMs).toBeGreaterThan(ELICITATION_HUMAN_TTL_MS - 10_000);
    expect(windowMs).toBeLessThan(ELICITATION_HUMAN_TTL_MS + 10_000);
  });

  test("an explicit expires_at from the caller wins", async () => {
    const conversation_id = await freshConversation();
    const pinned = new Date(Date.now() + 42 * 60_000); // allow-wall-clock
    const row = await createElicitation(
      {
        tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_choice",
        summary: "Pick one",
        input: { kind: "choice", question: "Pick one" },
        actor_id: null,
        expires_at: pinned,
      },
      ctx.db,
    );

    const [stored] = await ctx.db
      .select({ expires_at: conversationElicitations.expires_at })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, row.id));
    expect(stored?.expires_at.toISOString()).toBe(pinned.toISOString());
  });
});
