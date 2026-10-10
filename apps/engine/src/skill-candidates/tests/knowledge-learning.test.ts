import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { proposeLearning } from "../../agent/sessions.ts";
import type { LearningKind } from "../../api/agent-sessions.ts";
import type { Actor } from "../../audit/actor.ts";
import { approveSkillCandidateTool } from "../../conversations/tools/engine-api/writes/candidates.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { saveLearningTool } from "../../conversations/tools/save-learning.ts";
import type { Db } from "../../db/client.ts";
import { auditLog, knowledgeSourceVersions, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getKnowledgeSourceBySlug, searchKnowledge } from "../../knowledge/service.ts";
import { createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  approveSkillCandidate,
  getSkillCandidate,
  KnowledgeWriteNotAllowedError,
  listSkillCandidates,
  rejectSkillCandidate,
} from "../service.ts";

const skip = process.env.REQUIRES_PG === "0";
const nextUuid = createDeterministicUuidFactory(0x6c30_40);

let testDb: TestDb;
let tenantId: string;
let db: Db;
const proposer: Actor = { kind: "user", id: nextUuid() };
const approver: Actor = { kind: "user", id: nextUuid() };

function propose(
  title: string,
  body: string,
  opts: { kind?: LearningKind; domains?: string[]; actor?: Actor | null } = {},
) {
  return proposeLearning({
    tenant_id: tenantId,
    title,
    body,
    domains: opts.domains ?? ["ops"],
    kind: opts.kind ?? "fact",
    actor: opts.actor === undefined ? proposer : opts.actor,
    confidence: "high",
    evidence_summary: "explicit save_learning (conversation=test)",
    db,
  });
}

async function approve(candidate_id: string | null) {
  const out = await approveSkillCandidate(
    {
      tenant_id: tenantId,
      candidate_id: candidate_id ?? "",
      actor: approver,
      may_write_knowledge: true,
    },
    db,
  );
  if (!out) throw new Error("approve returned null");
  return out;
}

async function versionsOf(knowledge_source_id: string) {
  return db
    .select()
    .from(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, tenantId),
        eq(knowledgeSourceVersions.knowledge_source_id, knowledge_source_id),
      ),
    )
    .orderBy(asc(knowledgeSourceVersions.version));
}

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("knowledge-learning");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "knowledge-learning", display_name: "Knowledge Learning" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe.skipIf(skip)("a fact learning becomes knowledge", () => {
  test("a proposed fact names its proposer and waits as knowledge_learning", async () => {
    const result = await propose(
      "Pager rota",
      "The on-call is paged by phone between 22:00 and 07:00.",
    );
    expect(result.action).toBe("proposed");
    const candidate = await getSkillCandidate(tenantId, result.candidate_id ?? "", db);
    expect(candidate).toMatchObject({
      pattern_kind: "knowledge_learning",
      status: "proposed",
      proposed_by: proposer,
      tags: ["domain:ops"],
    });
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.resource_id, result.candidate_id ?? ""),
          eq(auditLog.action, "skill_candidate.proposed"),
        ),
      );
    expect(audits[0]?.actor_id).toBe(proposer.id);
  });

  test("open facts coexist instead of superseding each other", async () => {
    await propose("Escalation lead", "Escalate to the platform lead after 15 minutes.");
    const open = await listSkillCandidates(
      { tenant_id: tenantId, status: "proposed", pattern_kind: "knowledge_learning" },
      db,
    );
    expect(open.map((c) => c.title).sort()).toEqual(["Escalation lead", "Pager rota"]);
  });

  test("approving a fact creates learnings-<domain> as v1, authored by the approver", async () => {
    const [pager] = await listSkillCandidates(
      { tenant_id: tenantId, status: "proposed", pattern_kind: "knowledge_learning" },
      db,
    ).then((items) => items.filter((c) => c.title === "Pager rota"));
    const out = await approve(pager?.id ?? null);
    expect(out.skill_id).toBeNull();
    expect(out.knowledge).toMatchObject({ slug: "learnings-ops", version: 1 });
    expect(out.candidate.status).toBe("approved");

    const source = await getKnowledgeSourceBySlug(tenantId, "learnings-ops", db);
    expect(source).toMatchObject({ source_type: "inline", tags: ["domain:ops"], scope: "global" });
    const [v1] = await versionsOf(source?.id ?? "");
    expect(v1?.author_user_id).toBe(approver.id);
    expect(v1?.note).toBe(`proposed by user:${proposer.id}`);

    const hits = await searchKnowledge(
      { tenant_id: tenantId, query: "paged by phone", tags: ["domain:ops"] },
      db,
    );
    expect(hits[0]?.knowledge_source_id).toBe(source?.id);
  });

  test("the next fact appends a version and keeps what was there", async () => {
    const [escalation] = await listSkillCandidates(
      { tenant_id: tenantId, status: "proposed", pattern_kind: "knowledge_learning" },
      db,
    );
    const out = await approve(escalation?.id ?? null);
    expect(out.knowledge?.version).toBe(2);
    const versions = await versionsOf(out.knowledge?.knowledge_source_id ?? "");
    const text = versions[1]?.content.kind === "document" ? versions[1].content.text : "";
    expect(text).toContain("## Pager rota");
    expect(text).toContain("## Escalation lead");
    expect(text.indexOf("Pager rota")).toBeLessThan(text.indexOf("Escalation lead"));
  });

  test("a rejected fact is never proposed again", async () => {
    const first = await propose("Wrong rota", "Page by chat at night.");
    expect(
      await rejectSkillCandidate(
        { tenant_id: tenantId, candidate_id: first.candidate_id ?? "", actor_id: approver.id },
        db,
      ),
    ).toBe(true);
    expect((await propose("Wrong rota", "Page by chat at night.")).action).toBe("skipped");
  });

  test("a practice with the same title stays a skill and leaves the knowledge untouched", async () => {
    const source = await getKnowledgeSourceBySlug(tenantId, "learnings-ops", db);
    const before = await versionsOf(source?.id ?? "");
    const practice = await propose("Pager rota", "Always confirm the page was acknowledged.", {
      kind: "practice",
    });
    expect(practice.action).toBe("proposed");
    const candidate = await getSkillCandidate(tenantId, practice.candidate_id ?? "", db);
    expect(candidate?.pattern_kind).toBe("session_learning");
    const out = await approve(practice.candidate_id);
    expect(out.skill_id).not.toBeNull();
    expect(out.knowledge).toBeNull();
    expect(await versionsOf(source?.id ?? "")).toHaveLength(before.length);
  });

  test("save_learning passes the kind and the calling principal through", async () => {
    const robot: Actor = { kind: "system_account", id: nextUuid() };
    const ctx = {
      tenant_id: tenantId,
      conversation_id: nextUuid(),
      db,
      actor_id: robot.id,
      principal: {
        provider: "api_key",
        kind: robot.kind,
        id: robot.id,
        tenant_id: tenantId,
        roles: [],
      },
    } as unknown as ToolContext;
    const result = await saveLearningTool.execute(ctx, {
      kind: "fact",
      title: "Status page",
      body: "The public status page lives at status.example.test.",
      domains: ["ops"],
    });
    expect(result.ok).toBe(true);
    const id = (result.data as { candidate_id: string }).candidate_id;
    const candidate = await getSkillCandidate(tenantId, id, db);
    expect(candidate).toMatchObject({ pattern_kind: "knowledge_learning", proposed_by: robot });
    const practice = await saveLearningTool.execute(ctx, {
      title: "Status page wording",
      body: "Write incidents on the status page in plain words.",
    });
    const practiceId = (practice.data as { candidate_id: string }).candidate_id;
    expect((await getSkillCandidate(tenantId, practiceId, db))?.pattern_kind).toBe(
      "session_learning",
    );
  });

  test("a fact without a domain lands in the shared learnings source", async () => {
    const fact = await propose("Billing owner", "Finance owns the billing account.", {
      domains: [],
      actor: null,
    });
    const out = await approve(fact.candidate_id);
    expect(out.knowledge?.slug).toBe("learnings");
    const source = await getKnowledgeSourceBySlug(tenantId, "learnings", db);
    const [v1] = await versionsOf(source?.id ?? "");
    expect(v1?.note).toBe("proposed by an agent");
  });

  test("the service refuses a fact when the caller may not write knowledge", async () => {
    const fact = await propose("Billing cutoff", "Invoices close on the 3rd working day.");
    await expect(
      approveSkillCandidate(
        {
          tenant_id: tenantId,
          candidate_id: fact.candidate_id ?? "",
          actor: approver,
          may_write_knowledge: false,
        },
        db,
      ),
    ).rejects.toBeInstanceOf(KnowledgeWriteNotAllowedError);
    expect((await getSkillCandidate(tenantId, fact.candidate_id ?? "", db))?.status).toBe(
      "proposed",
    );
  });

  test("the chat tool refuses a fact for a role without knowledge:write", async () => {
    const role = await createRole(db, tenantId, "skill-only");
    await grantPermissionToRole(db, tenantId, role.id, "skill:write");
    const [curator] = await db
      .insert(users)
      .values({ tenant_id: tenantId, email: "skill-only@test.local", role_id: role.id })
      .returning();
    if (!curator) throw new Error("seed user failed");
    const fact = await propose("Status owner", "The status page is owned by the platform team.");
    const ctx = {
      tenant_id: tenantId,
      conversation_id: nextUuid(),
      db,
      actor_id: curator.id,
      principal: {
        provider: "api_key",
        kind: "user",
        id: curator.id,
        tenant_id: tenantId,
        roles: [],
      },
      engineClient: new EngineClient({ tenant_id: tenantId, actor_id: curator.id, db }),
    } as unknown as ToolContext;
    const result = await approveSkillCandidateTool.execute(ctx, {
      candidate_id: fact.candidate_id ?? "",
    });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      error: "permission_denied",
      permission: "knowledge:write",
    });
    expect((await getSkillCandidate(tenantId, fact.candidate_id ?? "", db))?.status).toBe(
      "proposed",
    );
  });

  test("a fact of several domains lands once and is found from every one of them", async () => {
    const first = await propose(
      "Shared on-call",
      "Billing and support share the weekend on-call.",
      {
        domains: ["support", "billing"],
      },
    );
    const out = await approve(first.candidate_id);
    expect(out.knowledge?.slug).toBe("learnings-support");
    const created = await getKnowledgeSourceBySlug(tenantId, "learnings-support", db);
    expect(created?.tags.sort()).toEqual(["domain:billing", "domain:support"]);

    const second = await propose("Refund window", "Refunds are possible for 14 days.", {
      domains: ["support", "payments"],
    });
    await approve(second.candidate_id);
    const merged = await getKnowledgeSourceBySlug(tenantId, "learnings-support", db);
    expect(merged?.tags.sort()).toEqual(["domain:billing", "domain:payments", "domain:support"]);
    for (const tag of ["domain:billing", "domain:payments", "domain:support"]) {
      const hits = await searchKnowledge(
        { tenant_id: tenantId, query: "refunds possible", tags: [tag] },
        db,
      );
      expect(hits[0]?.knowledge_source_id).toBe(merged?.id);
    }
    expect(await getKnowledgeSourceBySlug(tenantId, "learnings-payments", db)).toBeNull();
  });
});
