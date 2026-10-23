import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  apiKeys,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createSkill, updateSkill } from "../../skills/service.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, createSecondaryTenant, type HttpTestServer } from "./setup.ts";

interface ListBody {
  items: Array<{ id: string }>;
  total: number;
}

let srv: HttpTestServer;
const nextUuid = createDeterministicUuidFactory(20261023);

function headers(key = srv.apiKey): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

const nextHex = createDeterministicHexFactory(0xc0ae5e);

async function scopedKey(scopes: string[]): Promise<string> {
  const plaintext = `wf_live_${nextHex(16)}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: srv.userId,
    prefix: plaintext.slice(0, 12),
    token_sha256: createHash("sha256").update(plaintext).digest("hex"),
    scopes,
  });
  return plaintext;
}

async function seedConversation(title: string, tenant_id = srv.tenantId): Promise<string> {
  const [row] = await srv.db
    .insert(conversations)
    .values({ tenant_id, status: "active", title, owner_id: srv.userId })
    .returning();
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function mention(
  conversation_id: string,
  type: "skill" | "knowledge_source" | "workflow",
  id: string,
  tenant_id = srv.tenantId,
): Promise<void> {
  await srv.db.insert(conversationMessages).values({
    tenant_id,
    conversation_id,
    role: "user",
    content: { text: `look at @${type}`, references: [{ type, id, label: type }] },
  });
}

async function toolCall(
  conversation_id: string,
  tool: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  outcome: "ok" | "error" = "ok",
): Promise<void> {
  await srv.db.insert(conversationToolCalls).values({
    tenant_id: srv.tenantId,
    conversation_id,
    tool,
    input,
    output,
    outcome,
  });
}

async function list(query: string, key?: string): Promise<{ status: number; ids: string[] }> {
  const res = await fetch(`${srv.baseUrl}/v1/conversations?owner_kind=user&limit=200&${query}`, {
    headers: headers(key),
  });
  if (res.status !== 200) return { status: res.status, ids: [] };
  const body = (await res.json()) as ListBody;
  return { status: res.status, ids: body.items.map((item) => item.id).sort() };
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-references-list");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("GET /v1/conversations — referenced skill and knowledge source", () => {
  test("a skill lists conversations that mention it or loaded it, nothing else", async () => {
    const skillId = nextUuid();
    const otherSkill = nextUuid();
    const mentioned = await seedConversation("mentions the skill");
    await mention(mentioned, "skill", skillId);
    const loaded = await seedConversation("loaded the skill");
    await toolCall(
      loaded,
      "load_skill",
      { slug: "rules" },
      { slug: "rules", skill: { id: skillId, title: "Rules" } },
    );
    const failedLoad = await seedConversation("failed load");
    await toolCall(
      failedLoad,
      "load_skill",
      { slug: "rules" },
      { skill: { id: skillId } },
      "error",
    );
    const unrelated = await seedConversation("other skill");
    await mention(unrelated, "skill", otherSkill);
    const sameIdOtherType = await seedConversation("same id as knowledge source");
    await mention(sameIdOtherType, "knowledge_source", skillId);

    const result = await list(`referenced_skill_id=${skillId}`);
    expect(result.status).toBe(200);
    expect(result.ids).toEqual([mentioned, loaded].sort());
  });

  test("a knowledge source lists mentions, reads, fetches and search hits", async () => {
    const sourceId = nextUuid();
    const mentioned = await seedConversation("mentions the source");
    await mention(mentioned, "knowledge_source", sourceId);
    const read = await seedConversation("read the source");
    await toolCall(read, "read_knowledge", { knowledge_source_id: sourceId }, { chunks: [] });
    const fetched = await seedConversation("fetched the source");
    await toolCall(fetched, "get_knowledge_source", { id: sourceId }, { source: {} });
    const found = await seedConversation("found the source");
    await toolCall(
      found,
      "search_knowledge",
      { query: "deploy" },
      { hits: [{ id: nextUuid(), knowledge_source_id: sourceId, snippet: "deploy" }] },
    );
    const missed = await seedConversation("searched elsewhere");
    await toolCall(
      missed,
      "search_knowledge",
      { query: "deploy" },
      { hits: [{ id: nextUuid(), knowledge_source_id: nextUuid(), snippet: "deploy" }] },
    );

    const result = await list(`referenced_knowledge_source_id=${sourceId}`);
    expect(result.status).toBe(200);
    expect(result.ids).toEqual([mentioned, read, fetched, found].sort());
  });

  test("another tenant's conversations never appear", async () => {
    const skillId = nextUuid();
    const own = await seedConversation("own tenant");
    await mention(own, "skill", skillId);
    const secondary = await createSecondaryTenant(srv, "conv-references");
    const [foreign] = await srv.db
      .insert(conversations)
      .values({ tenant_id: secondary.tenantId, status: "active", title: "foreign" })
      .returning();
    if (!foreign) throw new Error("seed foreign conversation failed");
    await mention(foreign.id, "skill", skillId, secondary.tenantId);

    expect((await list(`referenced_skill_id=${skillId}`)).ids).toEqual([own]);
    const theirs = await fetch(
      `${srv.baseUrl}/v1/conversations?limit=200&referenced_skill_id=${skillId}`,
      { headers: headers(secondary.admin.apiKey) },
    );
    expect(theirs.status).toBe(200);
    const body = (await theirs.json()) as ListBody;
    expect(body.items.map((item) => item.id)).not.toContain(own);
  });

  test("the filter needs read permission on the referenced kind", async () => {
    const key = await scopedKey(["conversation:list", "skill:read"]);
    expect((await list(`referenced_skill_id=${nextUuid()}`, key)).status).toBe(200);
    expect((await list(`referenced_knowledge_source_id=${nextUuid()}`, key)).status).toBe(403);
  });
});

describe("GET /v1/skills/{id}/history/{audit_entry_id}", () => {
  test("returns title and body before and after the change", async () => {
    const skill = await createSkill(
      { tenant_id: srv.tenantId, input: { scope: "global", title: "rules", body: "a\nb" } },
      srv.db,
    );
    await updateSkill(srv.tenantId, skill.id, { body: "a\nc" }, null, srv.db);
    const history = await fetch(`${srv.baseUrl}/v1/skills/${skill.id}/history`, {
      headers: headers(),
    });
    const { items } = (await history.json()) as { items: Array<{ audit_entry_id: string }> };
    const entryId = items[0]?.audit_entry_id;
    expect(entryId).toBeDefined();

    const res = await fetch(`${srv.baseUrl}/v1/skills/${skill.id}/history/${entryId}`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      before: { title: string; body: string } | null;
      after: { title: string; body: string } | null;
    };
    expect(body.version).toBe(2);
    expect(body.before).toEqual({ title: "rules", body: "a\nb" });
    expect(body.after).toEqual({ title: "rules", body: "a\nc" });

    const missing = await fetch(`${srv.baseUrl}/v1/skills/${skill.id}/history/${nextUuid()}`, {
      headers: headers(),
    });
    expect(missing.status).toBe(404);
  });
});
