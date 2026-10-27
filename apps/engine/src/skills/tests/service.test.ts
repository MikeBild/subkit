import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { autoloadForUserTurn, loadActivationCatalog } from "../../conversations/skill-autoload.ts";
import { auditLog, skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resolveLoadedSkills } from "../../llm/core/context-assembler/loaded-skills.ts";
import {
  activateSkill,
  archiveSkill,
  createSkill,
  deleteSkill,
  getSkill,
  getSkillBySlug,
  listSkills,
  retrieveApplicableSkills,
  updateSkill,
} from "../service.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("skills_svc");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: legacy; review before changing
    .returning();
  return t!.id;
}

describe("skills/service", () => {
  test("installed intent phrases load only active same-tenant nonexperimental skills", async () => {
    const tenant_id = await seedTenant();
    const otherTenant = await seedTenant();
    async function prepare(tenant: string, title: string, experimental = false, activate = true) {
      const skill = await createSkill(
        {
          tenant_id: tenant,
          input: {
            scope: "global",
            title,
            body: "Installed package instructions",
            status: "draft",
            activates_when: [{ kind: "intent_keyword", word: "Rückfrage klären" }],
            maturity: experimental ? "experimental" : "stable",
          },
        },
        ctx.db,
      );
      if (activate) await activateSkill(tenant, skill.id, null, ctx.db);
      return skill.id;
    }
    const expected = await prepare(tenant_id, "Installed assistance");
    await prepare(otherTenant, "Other workspace");
    await prepare(tenant_id, "Experimental assistance", true);
    await prepare(tenant_id, "Draft assistance", false, false);
    const catalog = await loadActivationCatalog(tenant_id, ctx.db);
    const loaded = autoloadForUserTurn({ user_text: "Bitte die RÜCKFRAGE klären!" }, catalog, []);
    expect(loaded).toEqual([expected]);
    const resolved = await resolveLoadedSkills(tenant_id, loaded, [], [], ctx.db);
    expect(resolved.fullBody.map((skill) => skill.id)).toEqual([expected]);
    expect(resolved.fullBody[0]?.body).toBe("Installed package instructions");
    expect(autoloadForUserTurn({ user_text: "Anderes Thema" }, catalog, [])).toEqual([]);
  });
  test("createSkill persists unknown legacy actors and system actors as normalized pairs", async () => {
    const tenant_id = await seedTenant();
    const legacy = await createSkill(
      {
        tenant_id,
        input: { scope: "global", title: "legacy-actor", body: "test" },
        actor_id: tenant_id,
      },
      ctx.db,
    );
    const system = await createSkill(
      { tenant_id, input: { scope: "global", title: "system-actor", body: "test" } },
      ctx.db,
    );
    const entries = await ctx.db
      .select({
        resource_id: auditLog.resource_id,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "skill.created")));
    expect(entries.find((entry) => entry.resource_id === legacy.id)).toEqual({
      resource_id: legacy.id,
      actor_type: "unknown",
      actor_id: null,
    });
    expect(entries.find((entry) => entry.resource_id === system.id)).toEqual({
      resource_id: system.id,
      actor_type: "system",
      actor_id: null,
    });
  });

  test("CRUD + lifecycle + retrieval order", async () => {
    const tenant_id = await seedTenant();

    const global = await createSkill(
      {
        tenant_id,
        input: {
          scope: "global",
          title: "prefer-cursor",
          body: "Always prefer cursor pagination for list endpoints.",
          examples: ["GET /users?cursor=..."],
          best_practices: ["page_size <= 100"],
          pitfalls: ["never use offset with mutable lists"],
          doc_refs: ["https://docs.example/pagination"],
        },
      },
      ctx.db,
    );
    expect(global.scope).toBe("global");
    expect(global.status).toBe("active");
    expect(global.version).toBe(1);
    expect(global.examples).toEqual(["GET /users?cursor=..."]);

    await expect(
      createSkill({ tenant_id, input: { scope: "connector", title: "x", body: "x" } }, ctx.db),
    ).rejects.toThrow(/connector_id/);

    const fakeConnectorId = crypto.randomUUID(); // allow-random: legacy; review before changing
    const fakeWorkflowId = crypto.randomUUID();
    const connectorSkill = await createSkill(
      {
        tenant_id,
        input: {
          scope: "connector",
          connector_id: fakeConnectorId,
          title: "stripe-idempotency",
          body: "Always attach Idempotency-Key on Stripe POSTs.",
        },
      },
      ctx.db,
    );
    const archivedConnector = await createSkill(
      {
        tenant_id,
        input: {
          scope: "connector",
          connector_id: fakeConnectorId,
          title: "old-rule",
          body: "do not use",
        },
      },
      ctx.db,
    );
    await archiveSkill(tenant_id, archivedConnector.id, null, ctx.db);
    const workflowSkill = await createSkill(
      {
        tenant_id,
        input: {
          scope: "workflow",
          workflow_id: fakeWorkflowId,
          title: "midnight-no-page",
          body: "Never trigger page-roll mutations at midnight UTC.",
        },
      },
      ctx.db,
    );

    const fetched = await getSkill(tenant_id, global.id, ctx.db);
    expect(fetched?.id).toBe(global.id);
    const all = await listSkills({ tenant_id }, ctx.db);
    expect(all.length).toBeGreaterThanOrEqual(4);

    const patched = await updateSkill(
      tenant_id,
      global.id,
      { body: "Always prefer cursor pagination. Page size 100." },
      null,
      ctx.db,
    );
    expect(patched?.version).toBe(2);
    expect(patched?.examples).toEqual(["GET /users?cursor=..."]);
    await expect(
      updateSkill(
        tenant_id,
        global.id,
        { body: "Stale overwrite", expected_version: 1 },
        null,
        ctx.db,
      ),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });

    const reactivated = await activateSkill(tenant_id, patched!.id, null, ctx.db);
    expect(reactivated?.status).toBe("active");

    const applicable = await retrieveApplicableSkills(
      { tenant_id, connector_ids: [fakeConnectorId], workflow_ids: [fakeWorkflowId] },
      ctx.db,
    );
    const ids = applicable.map((s) => s.id);
    expect(ids).toContain(patched!.id);
    expect(ids).toContain(connectorSkill.id);
    expect(ids).toContain(workflowSkill.id);
    expect(ids).not.toContain(archivedConnector.id);
    const globalIdx = ids.indexOf(patched!.id);
    const connectorIdx = ids.indexOf(connectorSkill.id);
    const workflowIdx = ids.indexOf(workflowSkill.id);
    expect(globalIdx).toBeLessThan(connectorIdx);
    expect(connectorIdx).toBeLessThan(workflowIdx);

    const ok = await deleteSkill(tenant_id, workflowSkill.id, null, ctx.db);
    expect(ok).toBe(true);
    const gone = await getSkill(tenant_id, workflowSkill.id, ctx.db);
    expect(gone).toBeNull();
  });

  test("applies_to round-trips and narrows the applicable set per audience", async () => {
    const tenant_id = await seedTenant();
    const plain = await createSkill(
      { tenant_id, input: { scope: "global", title: "plain", body: "Both places." } },
      ctx.db,
    );
    expect(plain.applies_to).toBe("both");
    const chat = await createSkill(
      {
        tenant_id,
        input: { scope: "global", title: "chat", body: "Chat only.", applies_to: "chat" },
      },
      ctx.db,
    );
    expect(chat.applies_to).toBe("chat");
    const moved = await updateSkill(tenant_id, chat.id, { applies_to: "authoring" }, null, ctx.db);
    expect(moved?.applies_to).toBe("authoring");

    const forChat = await retrieveApplicableSkills({ tenant_id, audience: "chat" }, ctx.db);
    expect(forChat.map((s) => s.id)).toEqual([plain.id]);
    const forDrafting = await retrieveApplicableSkills(
      { tenant_id, audience: "authoring" },
      ctx.db,
    );
    expect(forDrafting.map((s) => s.id).sort()).toEqual([plain.id, chat.id].sort());
  });

  test("getSkill rejects non-UUID input without throwing", async () => {
    const tenant_id = await seedTenant();
    const result = await getSkill(tenant_id, "workflow-authoring", ctx.db);
    expect(result).toBeNull();
  });

  test("getSkillBySlug resolves a seeded skill by slug", async () => {
    const tenant_id = await seedTenant();
    const created = await createSkill(
      {
        tenant_id,
        input: {
          scope: "global",
          title: "Workflow authoring",
          body: "Authoring guidance for workflows.",
        },
      },
      ctx.db,
    );
    await ctx.db
      .update(skills)
      .set({ slug: "workflow-authoring", seed_source: "test-fixture" })
      .where(eq(skills.id, created.id));

    const found = await getSkillBySlug(tenant_id, "workflow-authoring", ctx.db);
    expect(found?.id).toBe(created.id);
    expect(found?.slug).toBe("workflow-authoring");

    const missing = await getSkillBySlug(tenant_id, "does-not-exist", ctx.db);
    expect(missing).toBeNull();
  });
});
