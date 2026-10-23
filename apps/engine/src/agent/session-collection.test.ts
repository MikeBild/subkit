import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import type { ToolContext } from "../conversations/tools/index.ts";
import { saveLearningTool } from "../conversations/tools/save-learning.ts";
import {
  catalogCategories,
  intakeItemEvidence,
  intakeItems,
  skillCandidates,
  systemAccounts,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { listIntakeItemEvidence } from "../knowledge/intake-session.ts";
import { searchKnowledge } from "../knowledge/service.ts";
import * as invokeModule from "../llm/core/invoke.ts";
import {
  type AgentSessionAnalyzeJob,
  processAgentSessionAnalyzeJob,
} from "../queue/handlers/agent-session-analyze.ts";
import { listProposedForAuthoring } from "../skill-candidates/service.ts";
import { listSkills } from "../skills/service.ts";
import { buildAgentBriefing } from "./briefing.ts";
import { collectSessionLearning } from "./sessions.ts";

let testDb: TestDb;
let tenantId = "";
const userId = "00000000-0000-4000-8000-00000000a001";

function toolCtx(conversationId: string): ToolContext {
  return {
    db: testDb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: userId,
    principal: {
      kind: "user",
      id: userId,
      tenant_id: tenantId,
    },
    connector_id: null,
    workflow_id: null,
  } as unknown as ToolContext;
}

async function itemById(id: string) {
  const rows = await testDb.db
    .select()
    .from(intakeItems)
    .where(and(eq(intakeItems.tenant_id, tenantId), eq(intakeItems.id, id)));
  const row = rows[0];
  if (!row) throw new Error(`intake item ${id} missing`);
  return row;
}

beforeAll(async () => {
  testDb = await createTestDb("session-collection");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "session-collection", display_name: "Session collection" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  await testDb.db.insert(catalogCategories).values({ tenant_id: tenantId, name: "blog-de" });
}, 60_000);

afterAll(async () => {
  await testDb?.cleanup();
}, 30_000);

afterEach(() => {
  (invokeModule.invoke as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("save_learning collects into intake", () => {
  test("a learning becomes a session intake item in the domain category, never a candidate", async () => {
    const result = await saveLearningTool.execute(toolCtx("10000000-0000-4000-8000-000000000001"), {
      kind: "practice",
      title: "Halbgeviertstrich als Gedankenstrich",
      body: "Gedankenstriche sind immer Halbgeviertstriche mit Leerzeichen.",
      domains: ["blog-de"],
      pitfalls: ["Nie den Bindestrich verwenden."],
    });
    expect(result.ok).toBe(true);
    const data = result.data as { outcome: string; intake_item_id: string };
    expect(data.outcome).toBe("collected");
    const item = await itemById(data.intake_item_id);
    expect(item.category).toBe("blog-de");
    expect(item.state).toBe("collected");
    expect(item.collected_by_type).toBe("user");
    expect(item.collected_by_id).toBe(userId);
    expect(item.body).toBe(
      "Gedankenstriche sind immer Halbgeviertstriche mit Leerzeichen.\n\nPitfalls:\n- Nie den Bindestrich verwenden.",
    );
    expect(item.original_snapshot).toMatchObject({
      origin: "session",
      agent: "save_learning",
      client: "chat",
      session_id: "10000000-0000-4000-8000-000000000001",
      domains: ["blog-de"],
      learning_kind: "practice",
      scope: "global",
      tags: ["domain:blog-de"],
    });
    const candidates = await testDb.db
      .select({ value: count() })
      .from(skillCandidates)
      .where(eq(skillCandidates.tenant_id, tenantId));
    expect(candidates[0]?.value).toBe(0);
  });

  test("a learning saved over MCP records the client that saved it", async () => {
    const result = await saveLearningTool.execute(
      {
        ...toolCtx("10000000-0000-4000-8000-0000000000c1"),
        surface: "mcp",
        mcp_client_name: "claude-code",
      },
      {
        kind: "practice",
        title: "Vor dem Build die Bundles neu erzeugen",
        body: "Vor jedem Build die eingebetteten Dateien neu erzeugen.",
        domains: [],
      },
    );
    const item = await itemById((result.data as { intake_item_id: string }).intake_item_id);
    expect(item.original_snapshot).toMatchObject({
      origin: "session",
      agent: "save_learning",
      client: "claude-code",
    });
  });

  test("a domain without a shared category lands in the collector's default category", async () => {
    const result = await saveLearningTool.execute(toolCtx("10000000-0000-4000-8000-000000000002"), {
      kind: "fact",
      title: "Rufbereitschaft per Telefon",
      body: "Die Rufbereitschaft wird per Telefon alarmiert.",
      domains: ["ops-unbekannt"],
    });
    const item = await itemById((result.data as { intake_item_id: string }).intake_item_id);
    expect(item.category).toBe("inbox");
    expect(item.original_snapshot).toMatchObject({ learning_kind: "fact" });
  });

  test("a replayed session adds nothing and another session adds evidence without a new version", async () => {
    const args = {
      kind: "practice" as const,
      title: "Keine ASCII-Umlaute",
      body: "Umlaute werden als echte Umlaute geschrieben.",
      domains: ["blog-de"],
    };
    const first = await saveLearningTool.execute(
      toolCtx("10000000-0000-4000-8000-000000000003"),
      args,
    );
    const itemId = (first.data as { intake_item_id: string }).intake_item_id;
    const replay = await saveLearningTool.execute(
      toolCtx("10000000-0000-4000-8000-000000000003"),
      args,
    );
    expect(replay.data).toMatchObject({ outcome: "replayed", intake_item_id: itemId });
    const other = await saveLearningTool.execute(toolCtx("10000000-0000-4000-8000-000000000004"), {
      ...args,
      title: "  keine ascii-umlaute ",
    });
    expect(other.data).toMatchObject({ outcome: "evidence_appended", intake_item_id: itemId });
    const evidence = await listIntakeItemEvidence(tenantId, itemId, testDb.db);
    expect(evidence.map((row) => row.session_id)).toEqual([
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
    ]);
    expect((await itemById(itemId)).version).toBe(1);
  });

  test("a token is masked before the item is stored", async () => {
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    const result = await saveLearningTool.execute(toolCtx("10000000-0000-4000-8000-000000000005"), {
      title: `Push mit ${token}`,
      body: `Vor dem Push ${token} setzen.`,
      domains: ["blog-de"],
    });
    const item = await itemById((result.data as { intake_item_id: string }).intake_item_id);
    expect(JSON.stringify(item)).not.toContain(token);
    expect(item.title).toContain("***REDACTED:pat***");
  });
});

describe("collected learnings stay out of ordinary retrieval", () => {
  test("search, skills, authoring context and the briefing never show an unconfirmed learning", async () => {
    const marker = "zitronenfaltersonderregel";
    const collected = await collectSessionLearning({
      tenant_id: tenantId,
      title: `Regel ${marker}`,
      body: `Der Body nennt die ${marker} ausdrücklich.`,
      kind: "practice",
      actor: null,
      session: { agent: "claude-code", session_id: "retrieval-session", domains: ["blog-de"] },
      evidence_excerpt: "user: merk dir das",
      db: testDb.db,
    });
    expect(collected.outcome).toBe("collected");
    expect(await searchKnowledge({ tenant_id: tenantId, query: marker }, testDb.db)).toEqual([]);
    expect(await listSkills({ tenant_id: tenantId, q: marker }, testDb.db)).toEqual([]);
    expect(await listProposedForAuthoring(tenantId, {}, testDb.db)).toEqual([]);
    const briefing = await buildAgentBriefing({
      tenant_id: tenantId,
      domains: ["blog-de"],
      budget_tokens: 16000,
      include_knowledge_index: true,
      include_intake: true,
      workflow_visible: null,
      connector_visible: null,
      file_visible: null,
      file_tenant_wide: false,
      db: testDb.db,
    });
    expect(briefing.markdown).not.toContain(marker);
    expect(briefing.intake?.sessions).toBeGreaterThan(0);
  });
});

describe("queued coding-agent sessions run the intake path", () => {
  test("a job in the existing payload shape collects once, attributed to the named collector", async () => {
    spyOn(invokeModule, "invoke").mockResolvedValue({
      object: {
        learnings: [
          {
            kind: "fact",
            title: "Deploy-Fenster am Dienstag",
            body: "Deployments laufen dienstags.",
            pitfalls: [],
            evidence: "user: wir deployen nur dienstags",
            confidence: "high",
          },
          {
            kind: "event",
            title: "Release gepusht",
            body: "Das Release ist gepusht.",
            pitfalls: [],
            confidence: "high",
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof invokeModule.invoke>>);
    const job = {
      id: "job-1",
      data: {
        tenant_id: tenantId,
        agent: "claude-code",
        repo: "example/blog",
        domains: ["blog-de"],
        transcript: "user: wir deployen nur dienstags\nassistant: verstanden",
      } satisfies AgentSessionAnalyzeJob,
    } as unknown as Job<AgentSessionAnalyzeJob>;
    await processAgentSessionAnalyzeJob(job, testDb.db);
    await processAgentSessionAnalyzeJob(job, testDb.db);

    const rows = await testDb.db
      .select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, tenantId),
          eq(intakeItems.title, "Deploy-Fenster am Dienstag"),
        ),
      );
    expect(rows).toHaveLength(1);
    const item = rows[0];
    if (!item) throw new Error("missing collected item");
    expect(item.original_snapshot).toMatchObject({
      origin: "session",
      agent: "claude-code",
      repo: "example/blog",
      evidence_excerpt: "user: wir deployen nur dienstags",
    });
    expect((item.original_snapshot as { session_id: string }).session_id).toMatch(
      /^transcript-[a-f0-9]{32}$/,
    );
    const [collector] = await testDb.db
      .select()
      .from(systemAccounts)
      .where(
        and(eq(systemAccounts.tenant_id, tenantId), eq(systemAccounts.name, "session-learnings")),
      );
    expect(item.collected_by_type).toBe("system_account");
    expect(item.collected_by_id).toBe(collector?.id ?? "");
    const evidence = await testDb.db
      .select({ value: count() })
      .from(intakeItemEvidence)
      .where(
        and(eq(intakeItemEvidence.tenant_id, tenantId), eq(intakeItemEvidence.item_id, item.id)),
      );
    expect(evidence[0]?.value).toBe(1);
    const events = await testDb.db
      .select({ value: count() })
      .from(intakeItems)
      .where(and(eq(intakeItems.tenant_id, tenantId), eq(intakeItems.title, "Release gepusht")));
    expect(events[0]?.value).toBe(0);
  });
});
