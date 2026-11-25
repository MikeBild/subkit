import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { getConfig, loadConfig } from "../../config/loader.ts";
import {
  auditLog,
  conversationMessages,
  conversations,
  conversationToolCalls,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import type { ConversationMessageRecord } from "../types.ts";
import {
  buildCompactionPrompt,
  COMPACTION_INPUT_MAX_CHARS,
  COMPACTION_MESSAGE_MAX_CHARS,
  compactConversation,
} from "./compact.ts";

const DRAFT_ID = "7f3c2a1e-9b4d-4c6e-8a2f-1d5e6b7c8d9a";
const APPROVAL_ID = "apr_4f9d2c7b1e";
const SECRET = `ghp_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"}`;
const REDACTED_PAT = "***REDACTED:pat***";

let ctx: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "subkit-cfg-compact-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/compact",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("conversation_compact");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-compact", display_name: "T-Compact" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
  resetMetricsRegistryForTests();
});

async function insertMessage(
  conversation_id: string,
  role: "user" | "assistant",
  text: string,
): Promise<string> {
  const [row] = await ctx.db
    .insert(conversationMessages)
    .values({ tenant_id, conversation_id, role, content: { text } })
    .returning({ id: conversationMessages.id });
  return row!.id;
}

async function seedConversation(owner_id: string | null = null): Promise<{
  conversation_id: string;
  run_call_id: string;
  connector_call_id: string;
}> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active", owner_id })
    .returning({ id: conversations.id });
  const conversation_id = conv!.id;
  await insertMessage(
    conversation_id,
    "user",
    "Build a nightly sync of HubSpot contacts into Postgres.",
  );
  const assistantId = await insertMessage(
    conversation_id,
    "assistant",
    `Draft workflow hubspot-nightly-sync created (draft ${DRAFT_ID}). I need approval before writing to Postgres.`,
  );
  const [runCall] = await ctx.db
    .insert(conversationToolCalls)
    .values({
      tenant_id,
      conversation_id,
      parent_message_id: assistantId,
      tool: "run_workflow",
      input: { workflow: "hubspot-nightly-sync" },
      output: { status: "needs_confirm", approval_id: APPROVAL_ID },
      approval_required: true,
      confirmation_state: "pending",
      outcome: "pending",
    })
    .returning({ id: conversationToolCalls.id });
  const [connectorCall] = await ctx.db
    .insert(conversationToolCalls)
    .values({
      tenant_id,
      conversation_id,
      parent_message_id: assistantId,
      tool: "call_connector",
      input: { connector: "hubspot-prod", path: "/crm/v3/owners" },
      output: { data: { api_token: SECRET, owners: 3 } },
      outcome: "ok",
    })
    .returning({ id: conversationToolCalls.id });
  await insertMessage(conversation_id, "user", "Go ahead, but keep contacts from 2024 too.");
  await insertMessage(conversation_id, "assistant", "Noted: contacts from 2024 stay in scope.");
  await insertMessage(conversation_id, "user", "What about rate limits?");
  await insertMessage(
    conversation_id,
    "assistant",
    "HubSpot allows 100 requests per 10 seconds; the sync paces itself.",
  );
  return { conversation_id, run_call_id: runCall!.id, connector_call_id: connectorCall!.id };
}

async function compactedRows(conversation_id: string): Promise<Record<string, unknown>[]> {
  const rows = await ctx.db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "system"),
        sql`${conversationMessages.content}->>'kind' = 'compacted'`,
      ),
    )
    .orderBy(conversationMessages.created_at);
  return rows.map((r) => r.content as Record<string, unknown>);
}

function compactionCount(mode: string): number | undefined {
  const entry = getMetrics()
    .snapshot()
    .find((s) => s.name === METRIC_NAMES.CONVERSATION_COMPACTION_TOTAL);
  return entry?.samples.find((s) => s.labels.mode === mode)?.value;
}

function record(
  overrides: Partial<ConversationMessageRecord> & Pick<ConversationMessageRecord, "id" | "role">,
): ConversationMessageRecord {
  return {
    conversation_id: "conv-1",
    content: null,
    model: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("compactConversation — semantic summary through the summarize flow", () => {
  test("records system-account attribution for manual compaction", async () => {
    const actor_id = "10000000-0000-4000-8000-000000000001";
    const seeded = await seedConversation(actor_id);

    await compactConversation(
      {
        tenant_id,
        conversation_id: seeded.conversation_id,
        actor_id,
        principal: {
          provider: "test",
          kind: "system_account",
          id: actor_id,
          tenant_id,
          roles: [],
        },
      },
      ctx.db,
    );

    const [entry] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "conversation.compacted"),
          eq(auditLog.resource_id, seeded.conversation_id),
        ),
      )
      .limit(1);
    expect(entry).toEqual({ actor_type: "system_account", actor_id });
  });

  test("does not infer a user from an untyped actor id", async () => {
    const seeded = await seedConversation();

    await compactConversation(
      {
        tenant_id,
        conversation_id: seeded.conversation_id,
        actor_id: "10000000-0000-4000-8000-000000000003",
      },
      ctx.db,
    );

    const [entry] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "conversation.compacted"),
          eq(auditLog.resource_id, seeded.conversation_id),
        ),
      )
      .limit(1);
    expect(entry).toEqual({ actor_type: "unknown", actor_id: null });
  });

  test("the summary carries the draft id and the open approval id, and the prompt is redacted", async () => {
    const seeded = await seedConversation();
    let seenPrompt = "";
    getMockProvider().generateOverrides.summarize = (last) => {
      seenPrompt = last;
      const draft = /draft ([0-9a-f-]{36})/.exec(last)?.[1] ?? "no-draft";
      const approval = /"approval_id":"([a-z0-9_]+)"/.exec(last)?.[1] ?? "no-approval";
      return { summary: `Draft ${draft} is waiting on approval ${approval}.` };
    };

    const result = await compactConversation(
      { tenant_id, conversation_id: seeded.conversation_id, actor_id: null },
      ctx.db,
    );

    expect(result.messages_collapsed).toBe(2);
    expect(result.summary.startsWith("Compacted 2 earlier message(s). ")).toBe(true);
    expect(result.summary).toContain(DRAFT_ID);
    expect(result.summary).toContain(APPROVAL_ID);

    const rows = await compactedRows(seeded.conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "compacted",
      mode: "semantic",
      collapsed: 2,
      summary: result.summary,
      text: result.summary,
    });

    expect(seenPrompt).toContain(`tool_call ${seeded.run_call_id} run_workflow [pending]`);
    expect(seenPrompt).toContain("needs_confirm");
    expect(seenPrompt).toContain(`tool_call ${seeded.connector_call_id} call_connector [ok]`);
    expect(seenPrompt).toContain("Build a nightly sync of HubSpot contacts into Postgres.");
    expect(seenPrompt).not.toContain(SECRET);
    expect(seenPrompt).toContain(REDACTED_PAT);

    expect(compactionCount("semantic")).toBe(1);
    expect(compactionCount("stub")).toBeUndefined();
  });

  test("a second compaction summarizes from the previous summary onward instead of re-reading the start", async () => {
    const seeded = await seedConversation();
    getMockProvider().generateOverrides.summarize = () => ({ summary: "First summary." });
    await compactConversation(
      { tenant_id, conversation_id: seeded.conversation_id, actor_id: null },
      ctx.db,
    );
    for (let i = 0; i < 3; i += 1) {
      await insertMessage(seeded.conversation_id, "user", `follow-up question ${i}`);
      await insertMessage(seeded.conversation_id, "assistant", `follow-up answer ${i}`);
    }

    let seenPrompt = "";
    getMockProvider().generateOverrides.summarize = (last) => {
      seenPrompt = last;
      return { summary: "Second summary." };
    };
    const result = await compactConversation(
      { tenant_id, conversation_id: seeded.conversation_id, actor_id: null },
      ctx.db,
    );

    expect(result.messages_collapsed).toBeGreaterThan(0);
    expect(seenPrompt).toContain("earlier summary: Compacted 2 earlier message(s). ");
    expect(seenPrompt).toContain("follow-up question 2");
    expect(seenPrompt).not.toContain("Build a nightly sync of HubSpot contacts into Postgres.");
    expect(seenPrompt).not.toContain(seeded.run_call_id);
    expect(await compactedRows(seeded.conversation_id)).toHaveLength(2);
  });
});

describe("compactConversation — fallback to the lexical stub", () => {
  test("a provider failure keeps today's stub text and reports mode=stub", async () => {
    const seeded = await seedConversation();
    getMockProvider().generateOverrides.summarize = () => {
      throw new Error("provider down");
    };

    const result = await compactConversation(
      { tenant_id, conversation_id: seeded.conversation_id, actor_id: null },
      ctx.db,
    );

    expect(result.messages_collapsed).toBe(2);
    expect(result.summary).toMatch(
      /^Compacted 2 earlier message\(s\)\. Opened with: "Build a nightly sync of HubSpot contacts into Postgres\."\. Most recent assistant turn: "HubSpot allows 100 requests per 10 seconds; the sync paces itself\."$/,
    );
    const rows = await compactedRows(seeded.conversation_id);
    expect(rows[0]).toMatchObject({ kind: "compacted", mode: "stub", collapsed: 2 });
    expect(compactionCount("stub")).toBe(1);
    expect(compactionCount("semantic")).toBeUndefined();
  });
});

describe("buildCompactionPrompt", () => {
  test("drops the oldest entries first and stays at or under the input cap", () => {
    const filler = "x".repeat(3_000);
    const messages = Array.from({ length: 60 }, (_, i) =>
      record({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: { text: `#${i} ${filler}` },
        created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    const prompt = buildCompactionPrompt(messages);
    expect(prompt.length).toBeLessThanOrEqual(COMPACTION_INPUT_MAX_CHARS);
    expect(prompt).toContain("assistant: #59 ");
    expect(prompt).not.toContain("user: #0 ");
    expect(prompt).toMatch(/\(\d+ older entries omitted\)/);
    const longest = Math.max(...prompt.split("\n").map((line) => line.length));
    expect(longest).toBeLessThanOrEqual(COMPACTION_MESSAGE_MAX_CHARS);
  });

  test("asks for decisions, open approvals, tool results and the draft state", () => {
    const prompt = buildCompactionPrompt([
      record({ id: "m1", role: "user", content: { text: "hello" } }),
    ]);
    expect(prompt).toContain("Decisions taken");
    expect(prompt).toContain("tool_call id and approval id");
    expect(prompt).toContain("last valid tool results");
    expect(prompt).toContain("current draft state");
    expect(prompt).toContain("user: hello");
  });

  test("redacts secret-shaped values before they reach the model", () => {
    const prompt = buildCompactionPrompt([
      record({ id: "m1", role: "assistant", content: { text: `token is ${SECRET}` } }),
    ]);
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain(REDACTED_PAT);
  });

  test("renders recorded decisions and an earlier summary, and skips other system rows", () => {
    const prompt = buildCompactionPrompt([
      record({
        id: "s1",
        role: "system",
        content: { kind: "compacted", summary: "Earlier: draft wf-a saved.", collapsed: 9 },
      }),
      record({ id: "s2", role: "system", content: { kind: "note", text: "hidden" } }),
      record({
        id: "t1",
        role: "tool",
        content: { decision: "declined", tool: "run_workflow", reason: "wrong env" },
      }),
    ]);
    expect(prompt).toContain("earlier summary: Earlier: draft wf-a saved.");
    expect(prompt).toContain("decision: run_workflow declined (wrong env)");
    expect(prompt).not.toContain("hidden");
  });
});
