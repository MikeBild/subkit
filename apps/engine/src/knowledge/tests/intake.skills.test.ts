import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { skills } from "../../db/schema/index.ts";
import { getSkill, updateSkill } from "../../skills/service.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource } from "../catalog.ts";
import {
  confirmIntakeProposal as confirmWithAuthorization,
  createIntakeProposal,
  getIntakeProposal,
  patchIntakeItem,
  resolveDomainKnowledgeTarget,
} from "../index.ts";
import {
  IntakeConfirmationActorError,
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeProposalConflictError,
} from "../intake-errors.ts";
import {
  actor,
  confirmIntakeProposal,
  createClip,
  ctx,
  newSkill,
  nextUuid,
  sessionItem,
  skip,
  useKnowledgeIntakeDb,
} from "./intake-fixtures.ts";

useKnowledgeIntakeDb();

describe.skipIf(skip)("session intake and skill targets", () => {
  test("a superseded skill edited after review makes the proposal stale and archives nothing", async () => {
    const superseded = await newSkill("Reviewed supersede guidance");
    const item = await sessionItem("Stale supersede learning");
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Stale supersede",
        body: "Must not be published.",
        target: {
          skill: {
            new: { title: "Stale supersede", scope: "global", tags: [], category: "jira" },
            supersedes: [{ skill_id: superseded.id, expected_version: superseded.version }],
          },
        },
      },
      ctx.testDb.db,
    );
    await updateSkill(
      ctx.tenantId,
      superseded.id,
      { body: "Edited after review." },
      null,
      ctx.testDb.db,
    );
    await expect(
      confirmWithAuthorization(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
          authorize: async () => {},
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow("a superseded skill has changed");
    expect((await getSkill(ctx.tenantId, superseded.id, ctx.testDb.db))?.status).toBe("active");
    expect(
      await ctx.testDb.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Stale supersede"))),
    ).toHaveLength(0);
  });

  test("a denied authorization publishes nothing and leaves the proposal reviewable", async () => {
    const superseded = await newSkill("Denied supersede guidance");
    const item = await sessionItem("Denied skill learning");
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Denied skill",
        body: "Must not be published.",
        target: {
          skill: {
            new: { title: "Denied skill", scope: "global", tags: [], category: "jira" },
            supersedes: [{ skill_id: superseded.id, expected_version: superseded.version }],
          },
        },
      },
      ctx.testDb.db,
    );
    await expect(
      confirmWithAuthorization(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
          authorize: async (requirements) => {
            if (requirements.some((entry) => entry.permission === "skill:archive"))
              throw new Error("missing skill:archive");
          },
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow("missing skill:archive");
    expect((await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db))?.status).toBe(
      "draft",
    );
    expect((await getSkill(ctx.tenantId, superseded.id, ctx.testDb.db))?.status).toBe("active");
    expect(
      await ctx.testDb.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Denied skill"))),
    ).toHaveLength(0);
  });

  test("updates an existing skill only at the reviewed version", async () => {
    const existing = await newSkill("Versioned guidance");
    const item = await sessionItem("Versioned skill learning");
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Versioned guidance",
        body: "Revised guidance body.",
        target: {
          skill: {
            skill_id: existing.id,
            expected_version: existing.version,
            supersedes: [],
          },
        },
      },
      ctx.testDb.db,
    );
    const second = await sessionItem("Second versioned skill learning");
    const staleProposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [second.id],
        title: "Versioned guidance",
        body: "A competing revision.",
        target: {
          skill: {
            skill_id: existing.id,
            expected_version: existing.version,
            supersedes: [],
          },
        },
      },
      ctx.testDb.db,
    );
    const confirmed = await confirmIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        digest: proposal.revision.digest,
      },
      ctx.testDb.db,
    );
    expect(confirmed?.confirmed_target_id).toBe(existing.id);
    expect(await getSkill(ctx.tenantId, existing.id, ctx.testDb.db)).toMatchObject({
      body: "Revised guidance body.",
      status: "active",
      version: existing.version + 1,
    });
    await expect(
      confirmIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: staleProposal.id,
          expected_revision: staleProposal.current_revision,
          digest: staleProposal.revision.digest,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeProposalConflictError);
  });

  test("rejects skill targets outside the tenant or naming archived skills", async () => {
    const item = await sessionItem("Invalid skill target learning");
    const archived = await newSkill("Archived target guidance");
    await ctx.testDb.db
      .update(skills)
      .set({ lifecycle: "archived" })
      .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.id, archived.id)));
    const base = {
      tenant_id: ctx.tenantId,
      actor,
      item_ids: [item.id],
      title: "Invalid target",
      body: "Never proposed.",
    };
    await expect(
      createIntakeProposal(
        {
          ...base,
          target: {
            skill: {
              skill_id: nextUuid(),
              expected_version: 1,
              supersedes: [],
            },
          },
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeNotFoundError);
    await expect(
      createIntakeProposal(
        {
          ...base,
          target: {
            skill: {
              new: {
                title: "Foreign connector skill",
                scope: "connector",
                connector_id: nextUuid(),
                tags: [],
                category: "jira",
              },
              supersedes: [],
            },
          },
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeNotFoundError);
    await expect(
      createIntakeProposal(
        {
          ...base,
          target: {
            skill: {
              new: { title: "Archived supersede", scope: "global", tags: [], category: "jira" },
              supersedes: [{ skill_id: archived.id, expected_version: archived.version }],
            },
          },
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);
  });

  test("an edited session item requires a fresh proposal before a skill admission", async () => {
    const item = await sessionItem("Edited skill learning");
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Edited skill",
        body: "Body reviewed before the edit.",
        target: {
          skill: {
            new: { title: "Edited skill", scope: "global", tags: [], category: "jira" },
            supersedes: [],
          },
        },
      },
      ctx.testDb.db,
    );
    await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        body: "Edited after the proposal was read.",
      },
      ctx.testDb.db,
    );
    await expect(
      confirmIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeProposalConflictError);
    expect(
      await ctx.testDb.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Edited skill"))),
    ).toHaveLength(0);
  });

  test("creates a domain bundle once and then targets it as an existing bundle", async () => {
    await upsertKnowledgeBundle(
      {
        tenant_id: ctx.tenantId,
        actor,
        input: { name: "Imported te-kit notes", tags: ["domain:te-kit"] },
        files: [{ path: "/imported.md", content: "# Imported\n" }],
      },
      ctx.testDb.db,
    );
    const initial = await resolveDomainKnowledgeTarget(
      { tenant_id: ctx.tenantId, domain: "te-kit" },
      ctx.testDb.db,
    );
    expect(initial).toEqual({
      name: "Knowledge · te-kit",
      category: "te-kit",
      tags: ["domain:te-kit"],
    });
    const first = await sessionItem("First domain fact");
    const racing = await sessionItem("Racing domain fact");
    const proposals: Awaited<ReturnType<typeof createIntakeProposal>>[] = [];
    for (const item of [first, racing])
      proposals.push(
        await createIntakeProposal(
          {
            tenant_id: ctx.tenantId,
            actor,
            item_ids: [item.id],
            title: item.title,
            body: `${item.title} body.`,
            target: initial,
          },
          ctx.testDb.db,
        ),
      );
    const confirm = (proposal: (typeof proposals)[number]) =>
      confirmIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
        },
        ctx.testDb.db,
      );
    const [admitted] = proposals;
    if (!admitted || !proposals[1]) throw new Error("domain proposals missing");
    const created = await confirm(admitted);
    await expect(confirm(proposals[1])).rejects.toBeInstanceOf(IntakeProposalConflictError);
    const next = await resolveDomainKnowledgeTarget(
      { tenant_id: ctx.tenantId, domain: "te-kit" },
      ctx.testDb.db,
    );
    const source = await getKnowledgeSource(
      ctx.tenantId,
      created?.confirmed_target_id ?? "",
      ctx.testDb.db,
    );
    expect(next).toEqual({
      knowledge_source_id: created?.confirmed_target_id ?? "",
      expected_version: source?.version ?? "",
    });

    const unrelated = await sessionItem("Separately named domain fact");
    const separate = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [unrelated.id],
        title: unrelated.title,
        body: "A separately named bundle with the same domain tag.",
        target: { name: "TE-Kit release notes", category: "te-kit", tags: ["domain:te-kit"] },
      },
      ctx.testDb.db,
    );
    const separateConfirmed = await confirm(separate);
    expect(separateConfirmed?.confirmed_target_id).not.toBe(created?.confirmed_target_id);
    expect(
      await resolveDomainKnowledgeTarget(
        { tenant_id: ctx.tenantId, domain: "te-kit" },
        ctx.testDb.db,
      ),
    ).toEqual(next);
  });
});

describe.skipIf(skip)("skill rules in intake confirmation", () => {
  test("a system account cannot publish skill rules even with every permission", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Delegated conventions",
        body: "Conventions prepared by a system account.",
        target: {
          skill: {
            new: { title: "Delegated conventions", scope: "global", tags: [], category: "ops" },
            supersedes: [],
            rules: [
              {
                rule_id: "delegated-timezone",
                type: "timezone",
                statement: "Schedules use Europe/Berlin.",
                payload: { value: "Europe/Berlin" },
              },
            ],
          },
        },
      },
      ctx.testDb.db,
    );
    await expect(
      confirmIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConfirmationActorError);
    expect(
      await ctx.testDb.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Delegated conventions"))),
    ).toEqual([]);
    expect((await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db))?.status).toBe(
      "draft",
    );
  });
});
