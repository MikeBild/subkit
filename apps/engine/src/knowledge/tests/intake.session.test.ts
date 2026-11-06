import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  catalogCategories,
  intakeItemEvidence,
  skills,
  systemAccounts,
} from "../../db/schema/index.ts";
import { getSkill } from "../../skills/service.ts";
import {
  confirmIntakeProposal as confirmWithAuthorization,
  createIntakeProposal,
  createSessionIntakeItem,
  getIntakeItem,
  intakeConfirmRequirements,
  listIntakeItemEvidence,
  sessionIntakeRequestId,
  setIntakeDefaultCategory,
} from "../index.ts";
import type { IntakeConfirmPermission } from "../intake-types.ts";
import { searchKnowledge } from "../service.ts";
import {
  actor,
  ctx,
  newSkill,
  nextUuid,
  sessionInput,
  sessionItem,
  skip,
  useKnowledgeIntakeDb,
} from "./intake-fixtures.ts";

useKnowledgeIntakeDb();

describe.skipIf(skip)("session intake and skill targets", () => {
  test("derives a deterministic version 5 request id from tenant, session, and normalized title", () => {
    const base = { tenant_id: ctx.tenantId, session_id: "session-a", title: "  Release  Gate " };
    const id = sessionIntakeRequestId(base);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionIntakeRequestId({ ...base, title: "release gate" })).toBe(id);
    expect(sessionIntakeRequestId({ ...base, session_id: "session-b" })).not.toBe(id);
  });

  test("collects a session item without a source address and keeps its provenance", async () => {
    const result = await createSessionIntakeItem(
      sessionInput({ title: "Session provenance item" }, { domains: ["subkit"] }),
      ctx.testDb.db,
    );
    expect(result.outcome).toBe("created");
    expect(result.item.original_snapshot).toMatchObject({
      origin: "session",
      agent: "claude-code",
      repo: "example/repo",
      domains: ["subkit"],
    });
    expect("source_url" in result.item.original_snapshot).toBe(false);
    expect(await listIntakeItemEvidence(ctx.tenantId, result.item.id, ctx.testDb.db)).toHaveLength(
      1,
    );
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [result.item.id],
        title: "Session proposal",
        body: "Retain the session learning.",
        target: { name: "Session learning knowledge" },
      },
      ctx.testDb.db,
    );
    expect(proposal.revision.items).toEqual([
      expect.objectContaining({ id: result.item.id, source_url: null }),
    ]);
    expect(
      (await searchKnowledge({ tenant_id: ctx.tenantId, query: "ticket text" }, ctx.testDb.db))
        .length,
    ).toBe(0);
  });

  test("places a session item in the declared domain category when the shared catalog has it", async () => {
    await ctx.testDb.db
      .insert(catalogCategories)
      .values({ tenant_id: ctx.tenantId, name: "release-domain" })
      .onConflictDoNothing();
    const inDomain = await createSessionIntakeItem(
      sessionInput(
        { title: "Domain placed learning" },
        { domains: ["Not_A_Category", "missing-domain", "release-domain"] },
      ),
      ctx.testDb.db,
    );
    expect(inDomain.item.category).toBe("release-domain");
    const collector = { kind: "user" as const, id: nextUuid() };
    await setIntakeDefaultCategory(
      { tenant_id: ctx.tenantId, actor: collector, category: "collector-default" },
      ctx.testDb.db,
    );
    const fallback = await createSessionIntakeItem(
      sessionInput(
        { title: "Default placed learning", actor: collector },
        { domains: ["missing-domain"] },
      ),
      ctx.testDb.db,
    );
    expect(fallback.item.category).toBe("collector-default");
  });

  test("appends evidence to a same-category title duplicate without a new version", async () => {
    const first = await createSessionIntakeItem(
      sessionInput({ title: "Duplicate session learning" }),
      ctx.testDb.db,
    );
    const replay = await createSessionIntakeItem(
      sessionInput(
        { title: "duplicate   session learning" },
        {
          session_id:
            first.item.original_snapshot.origin === "session"
              ? first.item.original_snapshot.session_id
              : "",
        },
      ),
      ctx.testDb.db,
    );
    expect(replay).toMatchObject({ outcome: "replayed", item: { id: first.item.id } });
    const second = await createSessionIntakeItem(
      sessionInput(
        { title: "Duplicate Session Learning" },
        { evidence_excerpt: "A later session repeated the learning." },
      ),
      ctx.testDb.db,
    );
    expect(second.outcome).toBe("evidence_appended");
    expect(second.item.id).toBe(first.item.id);
    const current = await getIntakeItem(ctx.tenantId, first.item.id, ctx.testDb.db);
    expect(current?.version).toBe(first.item.version);
    const evidence = await listIntakeItemEvidence(ctx.tenantId, first.item.id, ctx.testDb.db);
    expect(evidence.map((entry) => entry.excerpt)).toEqual([
      "The person asked to see the ticket text before filing it.",
      "A later session repeated the learning.",
    ]);
    await expect(
      ctx.testDb.db
        .update(intakeItemEvidence)
        .set({ excerpt: "rewritten" })
        .where(eq(intakeItemEvidence.item_id, first.item.id))
        .execute(),
    ).rejects.toThrow();
  });

  test("attributes a session item without an actor to the named session system account", async () => {
    const result = await createSessionIntakeItem(
      sessionInput({ title: "Unattributed session learning", actor: null }),
      ctx.testDb.db,
    );
    const [account] = await ctx.testDb.db
      .select()
      .from(systemAccounts)
      .where(
        and(
          eq(systemAccounts.tenant_id, ctx.tenantId),
          eq(systemAccounts.name, "session-learnings"),
        ),
      );
    expect(result.item.collected_by).toEqual({ kind: "system_account", id: account?.id ?? "" });
    const again = await createSessionIntakeItem(
      sessionInput({ title: "Second unattributed learning", actor: null }),
      ctx.testDb.db,
    );
    expect(again.item.collected_by).toEqual(result.item.collected_by);
  });

  test("a skill target requires skill rights and never knowledge write", () => {
    expect(
      intakeConfirmRequirements({
        skill: {
          new: { title: "Jira", scope: "global", tags: [], category: "jira" },
          supersedes: [{ skill_id: "10000000-0000-4000-8000-0000000000aa", expected_version: 1 }],
        },
      }).map((entry: IntakeConfirmPermission) => entry.permission),
    ).toEqual(["skill:write", "skill:activate", "skill:archive"]);
    expect(
      intakeConfirmRequirements({ name: "Knowledge" }).map((entry) => entry.permission),
    ).toEqual(["knowledge:write"]);
  });

  test("confirms a new active skill, archives superseded skills, and admits exactly once", async () => {
    const supersededA = await newSkill("Old jira guidance");
    const supersededB = await newSkill("Older jira guidance");
    const item = await sessionItem("Jira consolidation learning");
    const target = {
      skill: {
        new: {
          title: "Jira tickets",
          scope: "global" as const,
          tags: ["domain:jira"],
          category: "jira",
        },
        supersedes: [
          { skill_id: supersededA.id, expected_version: supersededA.version },
          { skill_id: supersededB.id, expected_version: supersededB.version },
        ],
      },
    };
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Jira tickets",
        body: "Draft the ticket in chat first and file it only after approval.",
        target,
      },
      ctx.testDb.db,
    );
    const seen: IntakeConfirmPermission[][] = [];
    const request = {
      tenant_id: ctx.tenantId,
      actor,
      id: proposal.id,
      expected_revision: proposal.current_revision,
      digest: proposal.revision.digest,
      authorize: async (requirements: readonly IntakeConfirmPermission[]) => {
        seen.push([...requirements]);
      },
    };
    const [first, second] = await Promise.all([
      confirmWithAuthorization(request, ctx.testDb.db),
      confirmWithAuthorization(request, ctx.testDb.db),
    ]);
    expect(first).toMatchObject({ status: "confirmed", confirmed_target_kind: "skill" });
    expect(second?.confirmed_target_id).toBe(first?.confirmed_target_id);
    expect(seen.flat().some((entry) => entry.permission === "knowledge:write")).toBe(false);
    const created = await getSkill(ctx.tenantId, first?.confirmed_target_id ?? "", ctx.testDb.db);
    expect(created).toMatchObject({ status: "active", title: "Jira tickets", category: "jira" });
    expect(created?.body).toBe("Draft the ticket in chat first and file it only after approval.");
    for (const id of [supersededA.id, supersededB.id])
      expect((await getSkill(ctx.tenantId, id, ctx.testDb.db))?.status).toBe("archived");
    expect(
      await ctx.testDb.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Jira tickets"))),
    ).toHaveLength(1);
    expect(await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db)).toMatchObject({
      state: "admitted",
      admitted_target_kind: "skill",
      admitted_target_id: first?.confirmed_target_id,
    });
    const [confirmedAudit] = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "intake_proposal.confirmed"),
          eq(auditLog.resource_id, proposal.id),
        ),
      );
    expect(confirmedAudit?.metadata).toMatchObject({
      target_kind: "skill",
      superseded_skill_ids: [supersededA.id, supersededB.id],
    });
  });
});
