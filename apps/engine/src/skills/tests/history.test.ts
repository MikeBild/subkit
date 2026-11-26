import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog, skills } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  createSkill,
  getSkillHistoryEntry,
  listSkillHistory,
  restoreSkill,
  updateSkill,
} from "../service.ts";

let ctx: TestDb;
const nextUuid = createDeterministicUuidFactory(20260611);

beforeAll(async () => {
  ctx = await createTestDb("skills_history");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("skills/history", () => {
  test("update writes full snapshots; history lists newest-first; restore round-trips", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const skill = await createSkill(
      {
        tenant_id,
        input: {
          scope: "global",
          title: "v1-title",
          body: "v1 body",
          tags: ["alpha"],
          best_practices: ["bp-1"],
        },
      },
      ctx.db,
    );

    const v2 = await updateSkill(
      tenant_id,
      skill.id,
      { title: "v2-title", body: "v2 body", tags: ["beta"] },
      null,
      ctx.db,
    );
    expect(v2?.version).toBe(2);
    const v3 = await updateSkill(tenant_id, skill.id, { body: "v3 body" }, null, ctx.db);
    expect(v3?.version).toBe(3);

    const history = await listSkillHistory(tenant_id, skill.id, ctx.db);
    expect(history.length).toBe(2);
    expect(history[0]!.version).toBe(3);
    expect(history[1]!.version).toBe(2);
    expect(history[1]!.title).toBe("v2-title");
    expect(history.every((h) => h.has_snapshot)).toBe(true);
    expect(history.every((h) => typeof h.updated_at === "string")).toBe(true);

    const outcome = await restoreSkill(
      tenant_id,
      skill.id,
      history[1]!.audit_entry_id,
      null,
      ctx.db,
    );
    const restored = outcome.ok ? outcome.skill : null;
    expect(restored?.version).toBe(4);
    expect(restored?.title).toBe("v2-title");
    expect(restored?.body).toBe("v2 body");
    expect(restored?.tags).toEqual(["beta"]);
    expect(restored?.best_practices).toEqual(["bp-1"]);

    const [live] = await ctx.db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, skill.id)))
      .limit(1);
    expect(live!.body).toBe("v2 body");
    expect(live!.body).not.toContain("REDACTED");
    expect(live!.title).toBe("v2-title");

    const afterRestore = await listSkillHistory(tenant_id, skill.id, ctx.db);
    expect(afterRestore.length).toBe(3);
    expect(afterRestore[0]!.version).toBe(4);
    expect(afterRestore[0]!.has_snapshot).toBe(true);
  });

  test("snapshot columns keep authored prose but still scrub credentials", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const prose = "Quote the pricing floor verbatim; never round it.";
    const pat = "dop_v1_c2648041abcdefabcdefabcdefabcdefabcdef";

    const skill = await createSkill(
      { tenant_id, input: { scope: "global", title: "boundary", body: "v1 body" } },
      ctx.db,
    );
    await updateSkill(tenant_id, skill.id, { body: `${prose} token=${pat}` }, null, ctx.db);

    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, skill.id)))
      .orderBy(desc(auditLog.ts))
      .limit(1);
    const after = row!.after as { body?: unknown };

    expect(typeof after.body).toBe("string");
    expect(after.body as string).toContain(prose);
    expect(after.body as string).not.toBe("***REDACTED:prompt***");
    expect(JSON.stringify(row!.after)).not.toContain(pat);
    expect(after.body as string).toContain("***REDACTED:pat***");
  });

  test("legacy thin audit entries surface has_snapshot=false and refuse restore with 409", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const skill = await createSkill(
      { tenant_id, input: { scope: "global", title: "thin-skill", body: "body" } },
      ctx.db,
    );
    const legacyId = nextUuid();
    await ctx.db.insert(auditLog).values({
      id: legacyId,
      tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.SKILL_UPDATED,
      resource_type: "skill",
      resource_id: skill.id,
      result: "success",
      before: { lifecycle: "active", version: 1, title: "thin-skill" },
      after: { lifecycle: "active", version: 2, title: "thin-skill-renamed" },
      metadata: {},
    });

    const history = await listSkillHistory(tenant_id, skill.id, ctx.db);
    const legacy = history.find((h) => h.audit_entry_id === legacyId);
    expect(legacy).toBeDefined();
    expect(legacy!.has_snapshot).toBe(false);
    expect(legacy!.version).toBe(2);
    expect(legacy!.title).toBe("thin-skill-renamed");
    expect(legacy!.lifecycle).toBe("active");

    expect(await restoreSkill(tenant_id, skill.id, legacyId, null, ctx.db)).toEqual({
      ok: false,
      rejection: "audit_entry_without_snapshot",
    });
  });

  test("restore rejects entries that do not reference this skill, and 404s unknown entries", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const a = await createSkill(
      { tenant_id, input: { scope: "global", title: "skill-a", body: "a" } },
      ctx.db,
    );
    const b = await createSkill(
      { tenant_id, input: { scope: "global", title: "skill-b", body: "b" } },
      ctx.db,
    );
    await updateSkill(tenant_id, a.id, { body: "a2" }, null, ctx.db);
    const aHistory = await listSkillHistory(tenant_id, a.id, ctx.db);
    expect(aHistory.length).toBe(1);

    expect(await restoreSkill(tenant_id, b.id, aHistory[0]!.audit_entry_id, null, ctx.db)).toEqual({
      ok: false,
      rejection: "audit_entry_not_a_skill_update",
    });

    expect(await restoreSkill(tenant_id, a.id, nextUuid(), null, ctx.db)).toEqual({
      ok: false,
      rejection: "audit_entry_not_found",
    });

    const otherTenant = (await seedTenant(ctx.db)).id;
    expect(await listSkillHistory(otherTenant, a.id, ctx.db)).toEqual([]);
    expect(
      await restoreSkill(otherTenant, a.id, aHistory[0]!.audit_entry_id, null, ctx.db),
    ).toEqual({ ok: false, rejection: "audit_entry_not_found" });
  });

  test("one history entry carries title and body before and after its change", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const skill = await createSkill(
      { tenant_id, input: { scope: "global", title: "rules", body: "line one\nline two" } },
      ctx.db,
    );
    await updateSkill(
      tenant_id,
      skill.id,
      { title: "rules v2", body: "line one\nline three" },
      null,
      ctx.db,
    );
    const [entry] = await listSkillHistory(tenant_id, skill.id, ctx.db);
    const detail = await getSkillHistoryEntry(tenant_id, skill.id, entry!.audit_entry_id, ctx.db);
    expect(detail?.version).toBe(2);
    expect(detail?.has_snapshot).toBe(true);
    expect(detail?.before).toEqual({ title: "rules", body: "line one\nline two" });
    expect(detail?.after).toEqual({ title: "rules v2", body: "line one\nline three" });

    const other = await createSkill(
      { tenant_id, input: { scope: "global", title: "other", body: "x" } },
      ctx.db,
    );
    expect(
      await getSkillHistoryEntry(tenant_id, other.id, entry!.audit_entry_id, ctx.db),
    ).toBeNull();
    expect(await getSkillHistoryEntry(tenant_id, skill.id, nextUuid(), ctx.db)).toBeNull();
    const otherTenant = (await seedTenant(ctx.db)).id;
    expect(
      await getSkillHistoryEntry(otherTenant, skill.id, entry!.audit_entry_id, ctx.db),
    ).toBeNull();
  });

  test("a thin legacy entry has no before or after state", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const skill = await createSkill(
      { tenant_id, input: { scope: "global", title: "thin", body: "body" } },
      ctx.db,
    );
    const legacyId = nextUuid();
    await ctx.db.insert(auditLog).values({
      id: legacyId,
      tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.SKILL_UPDATED,
      resource_type: "skill",
      resource_id: skill.id,
      result: "success",
      before: { lifecycle: "active", version: 1, title: "thin" },
      after: { lifecycle: "active", version: 2, title: "thin" },
      metadata: {},
    });
    const detail = await getSkillHistoryEntry(tenant_id, skill.id, legacyId, ctx.db);
    expect(detail?.has_snapshot).toBe(false);
    expect(detail?.before).toBeNull();
    expect(detail?.after).toBeNull();
  });
});
