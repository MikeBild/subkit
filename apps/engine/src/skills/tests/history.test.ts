// Skill version history + restore — read-time aggregation over audit_log.
// Covers: full snapshots on update, newest-first history, restore
// round-trip (content reverts, version bumps monotonically), and the
// 409 path for pre-snapshot (thin) audit entries.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";

import { AuditAction } from "../../audit/types.ts";
import { auditLog, skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { HttpError } from "../../http/errors.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createSkill, listSkillHistory, restoreSkill, updateSkill } from "../service.ts";

let ctx: TestDb;
const nextUuid = createDeterministicUuidFactory(20260611);

beforeAll(async () => {
  ctx = await createTestDb("skills_history");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${nextUuid().slice(0, 8)}`, display_name: "T" })
    .returning();
  return t!.id;
}

async function expectHttpError(p: Promise<unknown>, status: number): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    return err as HttpError;
  }
  throw new Error(`expected HttpError(${status}) to be thrown`);
}

describe("skills/history", () => {
  test("update writes full snapshots; history lists newest-first; restore round-trips", async () => {
    const tenant_id = await seedTenant();
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

    // Restore to the v2 snapshot: content reverts, version bumps monotonically.
    const restored = await restoreSkill(
      tenant_id,
      skill.id,
      history[1]!.audit_entry_id,
      null,
      ctx.db,
    );
    expect(restored?.version).toBe(4);
    expect(restored?.title).toBe("v2-title");
    expect(restored?.body).toBe("v2 body");
    expect(restored?.tags).toEqual(["beta"]);
    expect(restored?.best_practices).toEqual(["bp-1"]);

    // LOCAL-SK-SAEUBERER-FRISST-HISTORIE — the LIVE row, not just the
    // returned view. `restoreSkill` delegates to `updateSkill`, so whatever
    // the snapshot carried is written back as the skill's real body. When
    // the audit scrubber ran its prompt-prose net over `after`, this row
    // came back holding `***REDACTED:prompt***` and the authored text was
    // gone for good — append-only, no second copy. Asserting on the
    // returned object alone would not have caught the write.
    const [live] = await ctx.db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, skill.id)))
      .limit(1);
    expect(live!.body).toBe("v2 body");
    expect(live!.body).not.toContain("REDACTED");
    expect(live!.title).toBe("v2-title");

    // The restore itself is an audited update — history grows by one.
    const afterRestore = await listSkillHistory(tenant_id, skill.id, ctx.db);
    expect(afterRestore.length).toBe(3);
    expect(afterRestore[0]!.version).toBe(4);
    expect(afterRestore[0]!.has_snapshot).toBe(true);
  });

  // LOCAL-SK-SAEUBERER-FRISST-HISTORIE — the exemption's BOUNDARY.
  //
  // `audit_log.before` / `.after` skip the prompt-prose net so the skill
  // body stays restorable. They do NOT skip the two credential nets. This
  // pins both halves at once against the persisted row: authored prose
  // survives verbatim, while a credential-shaped VALUE inside that same
  // body and a credential-NAMED key beside it still collapse.
  //
  // Without this case the exemption would be a blank cheque; with it, a
  // future widening that lets a PAT through the snapshot turns red.
  test("snapshot columns keep authored prose but still scrub credentials", async () => {
    const tenant_id = await seedTenant();
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

    // Net 3 (prompt-prose) is OFF here: the authored text is readable.
    expect(typeof after.body).toBe("string");
    expect(after.body as string).toContain(prose);
    expect(after.body as string).not.toBe("***REDACTED:prompt***");
    // Net 1 (value-shape) is ON here: the PAT never reached disk.
    expect(JSON.stringify(row!.after)).not.toContain(pat);
    expect(after.body as string).toContain("***REDACTED:pat***");
    // Net 2 (sensitive-key) is covered on the same columns by
    // `audit/tests/metadata-scrub.test.ts`, which owns the writer-level rule.
  });

  test("legacy thin audit entries surface has_snapshot=false and refuse restore with 409", async () => {
    const tenant_id = await seedTenant();
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

    const err = await expectHttpError(
      restoreSkill(tenant_id, skill.id, legacyId, null, ctx.db),
      409,
    );
    expect(err.code).toBe("conflict");
    expect(err.hint).toContain("has_snapshot=true");
  });

  test("restore rejects entries that do not reference this skill, and 404s unknown entries", async () => {
    const tenant_id = await seedTenant();
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

    // Entry belongs to skill A — restoring skill B from it must 409.
    const err = await expectHttpError(
      restoreSkill(tenant_id, b.id, aHistory[0]!.audit_entry_id, null, ctx.db),
      409,
    );
    expect(err.code).toBe("conflict");
    expect(err.hint).toContain(`/v1/skills/${b.id}/history`);

    // Unknown audit entry id — 404.
    await expectHttpError(restoreSkill(tenant_id, a.id, nextUuid(), null, ctx.db), 404);

    // Tenant isolation: another tenant cannot see or restore from this history.
    const otherTenant = await seedTenant();
    expect(await listSkillHistory(otherTenant, a.id, ctx.db)).toEqual([]);
    await expectHttpError(
      restoreSkill(otherTenant, a.id, aHistory[0]!.audit_entry_id, null, ctx.db),
      404,
    );
  });
});
