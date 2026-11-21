import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { conversationMessages } from "../../db/schema/index.ts";
import { appendSnapshot } from "../draft.ts";
import {
  _resetDraftCredentialCacheForTests,
  getDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import { appendUserMessage, createConversation } from "../service/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("append_secret_capture");
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(() => {
  _resetDraftCredentialCacheForTests();
});

const FAKE_ATLASSIAN_TOKEN = "ATATTfake3xBfGH0aaaabbbbccccdddd1234";
const FAKE_GITHUB_TOKEN = "ghp_fakeFAKEfakeFAKEfakeFAKEfake123456";

async function seedConversationWithConnector(authType: "basic" | "bearer" | null): Promise<string> {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      initial_message: "hello",
    },
    ctx.testDb.db,
  );
  const conversation_id = created.conversation.id;
  if (authType) {
    const draft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "jira",
        slug: "jira",
        driver: "http",
        environment: "dev",
        auth_type: authType,
        base_url: "https://example.atlassian.net",
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);
  }
  return conversation_id;
}

async function readLastUserMessageText(conversation_id: string): Promise<string> {
  const rows = await ctx.testDb.db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, ctx.tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(asc(conversationMessages.created_at));
  const last = rows.at(-1);
  const content = last?.content as { text?: string } | null;
  return content?.text ?? "";
}

describe("appendUserMessage — secret scrub + capture", () => {
  test("pasted `email=…, api_token=ATATT…` on a basic draft → credential cached, text redacted + marker", async () => {
    const conversation_id = await seedConversationWithConnector("basic");

    const result = await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        message: `here you go: email=mike@example.com, api_token=${FAKE_ATLASSIAN_TOKEN}`,
      },
      ctx.testDb.db,
    );

    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "basic",
      username: "mike@example.com",
      password: FAKE_ATLASSIAN_TOKEN,
    });
    expect(result.message).not.toContain(FAKE_ATLASSIAN_TOKEN);
    expect(result.message).toContain("***REDACTED:");
    expect(result.message).toContain(
      "[secret captured: cached as draft credential (mode=basic) — do not re-collect; probe directly]",
    );
    expect(await readLastUserMessageText(conversation_id)).toBe(result.message);
  });

  test("lone bare token on a bearer draft → cached as bearer + marker", async () => {
    const conversation_id = await seedConversationWithConnector("bearer");

    const result = await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        message: FAKE_GITHUB_TOKEN,
      },
      ctx.testDb.db,
    );

    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "bearer",
      token: FAKE_GITHUB_TOKEN,
    });
    expect(result.message).not.toContain(FAKE_GITHUB_TOKEN);
    expect(result.message).toContain("(mode=bearer)");
    expect(await readLastUserMessageText(conversation_id)).toBe(result.message);
  });

  test("ambiguous paste with no connector draft → scrub only, no marker, nothing cached", async () => {
    const conversation_id = await seedConversationWithConnector(null);

    const result = await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        message: `random secret ${FAKE_GITHUB_TOKEN} in prose`,
      },
      ctx.testDb.db,
    );

    expect(getDraftCredential(conversation_id)).toBeNull();
    expect(result.message).not.toContain(FAKE_GITHUB_TOKEN);
    expect(result.message).toContain("***REDACTED:");
    expect(result.message).not.toContain("[secret captured");
    expect(await readLastUserMessageText(conversation_id)).toBe(result.message);
  });

  test("a message without secrets passes through untouched", async () => {
    const conversation_id = await seedConversationWithConnector("basic");

    const result = await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        message: "what does the latest probe say?",
      },
      ctx.testDb.db,
    );

    expect(result.message).toBe("what does the latest probe say?");
    expect(getDraftCredential(conversation_id)).toBeNull();
  });
});
