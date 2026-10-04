import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { auditLog, conversationMessages, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FORK_COPY_MESSAGE_CAP, forkConversation } from "./fork.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("fork_svc");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(label: string): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `T ${label}` })
    .returning();
  return t!.id;
}

interface Seeded {
  tenant_id: string;
  conversation_id: string;
  message_ids: string[];
}

async function seedConversationWithMessages(tenantLabel: string, count: number): Promise<Seeded> {
  const tenant_id = await seedTenant(tenantLabel);
  const [conv] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id,
      status: "active",
      title: `seed-${tenantLabel}`,
      memory: "carry-over memory",
      loaded_skills: [{ slug: "baseline.skill", last_turn: 0 }],
    })
    .returning();
  const conversation_id = conv!.id;
  const message_ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const [msg] = await ctx.db
      .insert(conversationMessages)
      .values({
        tenant_id,
        conversation_id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: { text: `turn-${i}` },
        model: i === 1 ? "provider/model-v1" : null,
      })
      .returning();
    message_ids.push(msg!.id);
    await new Promise((r) => setImmediate(r));
  }
  return { tenant_id, conversation_id, message_ids };
}

describe("forkConversation", () => {
  test("happy path: copies messages 0..N, returns new conversation id, writes audit row", async () => {
    const seed = await seedConversationWithMessages("happy", 5);
    const anchor = seed.message_ids[2]!;

    const result = await forkConversation(
      {
        tenant_id: seed.tenant_id,
        source_conversation_id: seed.conversation_id,
        anchor_message_id: anchor,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );

    expect(result).not.toBeNull();
    expect(result!.copied_message_count).toBe(3);
    expect(result!.source_conversation_id).toBe(seed.conversation_id);
    expect(result!.anchor_message_id).toBe(anchor);
    expect(result!.conversation.id).not.toBe(seed.conversation_id);

    const forked = await ctx.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, seed.tenant_id),
          eq(conversationMessages.conversation_id, result!.conversation.id),
        ),
      )
      .orderBy(asc(conversationMessages.created_at));
    expect(forked.length).toBe(3);
    expect(forked[1]?.model).toBe("provider/model-v1");
    for (const row of forked) {
      expect(seed.message_ids).not.toContain(row.id);
      expect(row.tenant_id).toBe(seed.tenant_id);
    }

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, seed.tenant_id),
          eq(auditLog.resource_id, result!.conversation.id),
        ),
      );
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("conversation.forked");
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta.forked_from).toBe(seed.conversation_id);
    expect(meta.anchor_message_id).toBe(anchor);
    expect(meta.copied_message_count).toBe(3);
    expect(meta.truncated).toBe(false);
    expect(meta.source_message_count).toBe(3);
    expect(result!.truncated).toBe(false);
    expect(meta.request_source).toBe("api");
  });

  test("cross-tenant source conversation returns null (no row leak)", async () => {
    const a = await seedConversationWithMessages("tenant-a", 2);
    const otherTenant = await seedTenant("tenant-b");

    const result = await forkConversation(
      {
        tenant_id: otherTenant,
        source_conversation_id: a.conversation_id,
        anchor_message_id: a.message_ids[0]!,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );

    expect(result).toBeNull();

    const bConvs = await ctx.db
      .select()
      .from(conversations)
      .where(eq(conversations.tenant_id, otherTenant));
    expect(bConvs.length).toBe(0);
  });

  test("anchor message belonging to a different conversation returns null", async () => {
    const a = await seedConversationWithMessages("anchor-a", 2);
    const b = await seedConversationWithMessages("anchor-b", 2);

    const result = await forkConversation(
      {
        tenant_id: a.tenant_id,
        source_conversation_id: a.conversation_id,
        anchor_message_id: b.message_ids[0]!,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );

    expect(result).toBeNull();
  });

  test("seeds the fork with source memory + loaded_skills (verbatim)", async () => {
    const seed = await seedConversationWithMessages("seed-state", 1);
    const result = await forkConversation(
      {
        tenant_id: seed.tenant_id,
        source_conversation_id: seed.conversation_id,
        anchor_message_id: seed.message_ids[0]!,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );
    expect(result).not.toBeNull();
    const [forkRow] = await ctx.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, result!.conversation.id));
    expect(forkRow!.memory).toBe("carry-over memory");
    expect(forkRow!.loaded_skills).toEqual([{ slug: "baseline.skill", last_turn: 0 }]);
    expect(forkRow!.title).toMatch(/^fork — /);
  });

  test("anchor with `created_at > now` excludes itself + later (deterministic window)", async () => {
    const seed = await seedConversationWithMessages("window", 5);
    const result = await forkConversation(
      {
        tenant_id: seed.tenant_id,
        source_conversation_id: seed.conversation_id,
        anchor_message_id: seed.message_ids[1]!,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );
    expect(result!.copied_message_count).toBe(2);
  });

  test("under the cap, truncated is false and source_message_count matches", async () => {
    const seed = await seedConversationWithMessages("under-cap", 3);
    const result = await forkConversation(
      {
        tenant_id: seed.tenant_id,
        source_conversation_id: seed.conversation_id,
        anchor_message_id: seed.message_ids[2]!,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );
    expect(result!.copied_message_count).toBe(3);
    expect(result!.truncated).toBe(false);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, seed.tenant_id),
          eq(auditLog.resource_id, result!.conversation.id),
        ),
      );
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta.truncated).toBe(false);
    expect(meta.source_message_count).toBe(3);
    expect(meta.copy_cap).toBe(FORK_COPY_MESSAGE_CAP);
  });
});
