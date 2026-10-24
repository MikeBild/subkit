import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  catalogCategories,
  intakeItemEvidence,
  skills,
  systemAccounts,
  tenants,
} from "../../db/schema/index.ts";
import { createSkill, getSkill, updateSkill } from "../../skills/service.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { renameCategory } from "../../workflows/catalog-view.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource, listKnowledgeSources } from "../catalog.ts";
import {
  confirmIntakeProposal as confirmWithAuthorization,
  createIntakeItem,
  createIntakeProposal,
  createSessionIntakeItem,
  getIntakeItem,
  getIntakeProposal,
  intakeConfirmRequirements,
  listIntakeCategories,
  listIntakeItemEvidence,
  listIntakeItems,
  patchIntakeItem,
  resolveDomainKnowledgeTarget,
  reviseIntakeProposal,
  sessionIntakeRequestId,
  setIntakeDefaultCategory,
} from "../index.ts";
import {
  IntakeConfirmationActorError,
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeProposalConflictError,
} from "../intake-errors.ts";
import type { ConfirmIntakeProposalParams, IntakeConfirmPermission } from "../intake-types.ts";
import { searchKnowledge } from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";
const nextUuid = createDeterministicUuidFactory(0x1a2b_3c4d);
const actor = { kind: "system_account" as const, id: nextUuid() };
let ctx: KnowledgeTestCtx;

function confirmIntakeProposal(
  p: Omit<ConfirmIntakeProposalParams, "authorize">,
  db: Parameters<typeof confirmWithAuthorization>[1],
) {
  return confirmWithAuthorization({ ...p, authorize: async () => {} }, db);
}

function createClip(overrides: Partial<Parameters<typeof createIntakeItem>[0]> = {}) {
  return createIntakeItem(
    {
      tenant_id: ctx.tenantId,
      actor,
      client_request_id: nextUuid(),
      title: "Tape recording idea",
      source_url: "https://example.test/tape",
      source_author: "Author",
      published_at: "Spring issue",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "The original clip says useful things.",
      note: "Review this for the product guide.",
      ...overrides,
    },
    ctx.testDb.db,
  );
}

beforeAll(async () => {
  if (!skip) ctx = await createKnowledgeTestCtx("intake");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge intake", () => {
  test("collects an immutable source snapshot into a per-principal default", async () => {
    const requestId = nextUuid();
    const first = await createClip({ client_request_id: requestId });
    const repeated = await createClip({ client_request_id: requestId });
    expect(repeated.id).toBe(first.id);
    expect(first.original_snapshot).toMatchObject({
      title: "Tape recording idea",
      source_url: "https://example.test/tape",
      published_at: "Spring issue",
      origin: "capture",
    });
    const categories = await listIntakeCategories(
      { tenant_id: ctx.tenantId, actor },
      ctx.testDb.db,
    );
    expect(categories.default_category).toBe("inbox");
    expect(categories.items).toContainEqual(
      expect.objectContaining({ category: "inbox", is_default: true }),
    );

    const edited = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: first.id,
        expected_version: first.version,
        body: "Edited working copy",
        note: "Edited note",
      },
      ctx.testDb.db,
    );
    expect(edited?.body).toBe("Edited working copy");
    expect(edited?.original_snapshot.body).toBe("The original clip says useful things.");
    await expect(
      patchIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: first.id,
          expected_version: first.version,
          title: "A stale edit must fail",
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    const afterEditRetry = await createClip({ client_request_id: requestId });
    expect(afterEditRetry.id).toBe(first.id);
  });

  test("collects a note without a source address as a redacted, audited intake entry", async () => {
    const pat = `ghp_${"c3D4".repeat(9)}`;
    const requestId = nextUuid();
    const params = {
      client_request_id: requestId,
      source_url: undefined,
      source_author: undefined,
      published_at: undefined,
      note: undefined,
      title: "Idea for the onboarding",
      body: `Ask about the team size first. token ${pat}`,
    };
    const note = await createClip(params);
    expect(note.state).toBe("collected");
    expect(note.admitted_target_id).toBeNull();
    expect(note.original_snapshot).toEqual({
      title: "Idea for the onboarding",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Ask about the team size first. token ***REDACTED:pat***",
      origin: "note",
      redactions: 1,
    });
    expect(JSON.stringify(note)).not.toContain(pat);
    expect((await createClip(params)).id).toBe(note.id);
    await expect(
      createClip({ ...params, source_url: "https://example.test/now-with-address" }),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    const [audit] = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "intake_item.collected"),
          eq(auditLog.resource_id, note.id),
        ),
      );
    expect(audit?.metadata).toMatchObject({ origin: "note", source_url: null, redactions: 1 });
  });

  test("filters listed entries by origin within the tenant", async () => {
    const clip = await createClip({ title: "Origin filter clip" });
    const note = await createClip({ title: "Origin filter note", source_url: undefined });
    const session = (
      await createSessionIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          title: "Origin filter session learning",
          body: "Prepared by an agent from a work session.",
          captured_at: "2026-10-10T07:00:00.000Z",
          session: {
            agent: "claude-code",
            session_id: `session-${nextUuid()}`,
            repo: null,
            domains: [],
            evidence_excerpt: "The agent noticed this during the session.",
          },
        },
        ctx.testDb.db,
      )
    ).item;
    const ids = async (origin: "capture" | "note" | "session") => {
      const items = await listIntakeItems({ tenant_id: ctx.tenantId, origin }, ctx.testDb.db);
      expect(items.every((item) => item.tenant_id === ctx.tenantId)).toBe(true);
      return items.map((item) => item.id);
    };
    const fromAgents = await ids("session");
    expect(fromAgents).toContain(session.id);
    expect(fromAgents).not.toContain(clip.id);
    expect(fromAgents).not.toContain(note.id);
    const notes = await ids("note");
    expect(notes).toContain(note.id);
    expect(notes).not.toContain(clip.id);
    const captures = await ids("capture");
    expect(captures).toContain(clip.id);
    expect(captures).not.toContain(note.id);
    expect(captures).not.toContain(session.id);
    expect(
      await listIntakeItems({ tenant_id: nextUuid(), origin: "session" }, ctx.testDb.db),
    ).toEqual([]);
  });

  test("redacts secrets from a collected clip and keeps prose, code and URLs intact", async () => {
    const pat = `ghp_${"a1B2".repeat(9)}`;
    const bearer = "Bearer fixture.token_value-123456";
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nZml4dHVyZS1rZXktbWF0ZXJpYWw=\n-----END PRIVATE KEY-----";
    const prose =
      "Bearer authentication is described at https://example.test/Understanding-OAuth2-And-OpenID-Connect-In-2024-Guide?page=2. const total = items.reduce((a, b) => a + b, 0);";
    const requestId = nextUuid();
    const params = {
      client_request_id: requestId,
      title: `Deploy notes ${pat}`,
      body: `${prose}\nAuthorization: ${bearer}\n${privateKey}`,
      note: `token ${pat}`,
    };
    const item = await createClip(params);
    const stored = JSON.stringify(item);
    expect(stored).not.toContain(pat);
    expect(stored).not.toContain("fixture.token_value-123456");
    expect(stored).not.toContain("Zml4dHVyZS1rZXktbWF0ZXJpYWw=");
    expect(item.title).toBe("Deploy notes ***REDACTED:pat***");
    expect(item.note).toBe("token ***REDACTED:pat***");
    expect(item.body).toContain(prose);
    expect(item.original_snapshot.body).toBe(item.body);
    expect(item.original_snapshot).toMatchObject({
      title: item.title,
      source_url: "https://example.test/tape",
      source_author: "Author",
      captured_at: "2026-10-10T07:00:00.000Z",
      redactions: 4,
    });
    expect(item.collected_by).toEqual(actor);

    const repeated = await createClip(params);
    expect(repeated.id).toBe(item.id);
    await expect(createClip({ ...params, body: "Different" })).rejects.toBeInstanceOf(
      IntakeConflictError,
    );

    const [audit] = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "intake_item.collected"),
          eq(auditLog.resource_id, item.id),
        ),
      );
    expect(audit?.metadata).toMatchObject({ redactions: 4 });
    expect(JSON.stringify(audit?.metadata)).not.toContain(pat);

    const clean = await createClip();
    expect(clean.original_snapshot).not.toHaveProperty("redactions");

    const edited = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: clean.id,
        expected_version: clean.version,
        body: `pasted again ${pat}`,
      },
      ctx.testDb.db,
    );
    expect(edited?.body).toBe("pasted again ***REDACTED:pat***");
  });

  test("renaming or moving an intake item never makes it searchable knowledge", async () => {
    const item = await createClip();
    const moved = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        category: "research",
      },
      ctx.testDb.db,
    );
    expect(moved?.category).toBe("research");
    expect(
      (await searchKnowledge({ tenant_id: ctx.tenantId, query: "original clip" }, ctx.testDb.db))
        .length,
    ).toBe(0);
  });

  test("category changes stale a reviewed proposal without changing the original source", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Recording workflow",
        body: "Review the source before publishing.",
        target: { name: "Recording workflow" },
      },
      ctx.testDb.db,
    );
    const moved = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        category: "research",
      },
      ctx.testDb.db,
    );
    expect(moved).toMatchObject({ category: "research", version: item.version + 1 });
    expect(moved?.original_snapshot).toEqual(item.original_snapshot);
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
    const revised = await reviseIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        item_ids: [item.id],
        title: "Recording workflow",
        body: "Review the source before publishing.",
        target: { name: "Recording workflow" },
      },
      ctx.testDb.db,
    );
    expect(revised?.status).toBe("draft");
  });

  test("working-copy changes stale a reviewed proposal without changing the source snapshot", async () => {
    for (const change of [
      { title: "Edited title" },
      { body: "Edited working copy" },
      { note: "Edited note" },
      { state: "collected" as const },
    ]) {
      const item = await createClip();
      const proposal = await createIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          item_ids: [item.id],
          title: "Recording workflow",
          body: "Review the source before publishing.",
          target: { name: "Recording workflow" },
        },
        ctx.testDb.db,
      );
      const edited = await patchIntakeItem(
        { tenant_id: ctx.tenantId, actor, id: item.id, expected_version: item.version, ...change },
        ctx.testDb.db,
      );
      expect(edited?.original_snapshot).toEqual(item.original_snapshot);
      expect((await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db))?.status).toBe(
        "stale",
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
    }
  });

  test("renaming a shared intake category versions clips and stales affected targets", async () => {
    const item = await createClip({ category: "recording" });
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Recording guidance",
        body: "Keep source context.",
        target: { name: "Recording guidance", category: "recording" },
      },
      ctx.testDb.db,
    );
    const moved = await renameCategory(
      {
        tenant_id: ctx.tenantId,
        from: "recording",
        to: "audio",
        actor_type: "system",
        purpose: null,
        aliases: [],
        expected_source_revision: 1,
        expected_target_revision: null,
      },
      ctx.testDb.db,
    );
    expect(moved.moved.intake).toBe(1);
    expect(await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db)).toMatchObject({
      category: "audio",
      version: item.version + 1,
      original_snapshot: item.original_snapshot,
    });
    expect((await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db))?.status).toBe(
      "stale",
    );
  });

  test("does not expose a clip across tenants", async () => {
    const item = await createClip();
    const [otherTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "t-intake-other", display_name: "Other intake tenant" })
      .returning();
    if (!otherTenant) throw new Error("other tenant insertion failed");
    expect(await getIntakeItem(otherTenant.id, item.id, ctx.testDb.db)).toBeNull();
  });

  test("serializes concurrent defaults and idempotent requests", async () => {
    const requestId = nextUuid();
    const [first, second] = await Promise.all([
      createClip({ client_request_id: requestId }),
      createClip({ client_request_id: requestId }),
    ]);
    expect(first.id).toBe(second.id);
    const defaults = await listIntakeCategories({ tenant_id: ctx.tenantId, actor }, ctx.testDb.db);
    expect(defaults.default_category).toBe("inbox");
    await expect(
      createClip({ client_request_id: requestId, body: "Different" }),
    ).rejects.toBeInstanceOf(IntakeConflictError);
  });

  test("keeps proposal source references from the reviewed revision", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Source snapshot",
        body: "Review the source.",
        target: { name: "Source snapshots" },
      },
      ctx.testDb.db,
    );
    await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        title: "Edited title",
      },
      ctx.testDb.db,
    );
    const current = await reviseIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        item_ids: [item.id],
        title: "Source snapshot",
        body: "Review the source.",
        target: { name: "Source snapshots" },
      },
      ctx.testDb.db,
    );
    expect(proposal.revision.items[0]?.title).toBe("Tape recording idea");
    expect(current?.revision.items[0]?.title).toBe("Edited title");
  });

  test("requires the exact current proposal and clip revisions before atomic admission", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Recording workflow",
        body: "Keep the original take and the FX take.",
        target: { name: "Product research" },
      },
      ctx.testDb.db,
    );
    const changed = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        note: "Changed after proposal",
      },
      ctx.testDb.db,
    );
    expect(changed?.state).toBe("reviewing");
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

    const revised = await reviseIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        item_ids: [item.id],
        title: "Recording workflow",
        body: "Keep the original take and the FX take.",
        target: { name: "Product research" },
      },
      ctx.testDb.db,
    );
    expect(revised?.current_revision).toBe(2);
    const admitted = await confirmIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: revised!.current_revision,
        digest: revised!.revision.digest,
      },
      ctx.testDb.db,
    );
    expect(admitted?.status).toBe("confirmed");
    expect(admitted?.confirmed_target_id).toBeDefined();
    const source = await getKnowledgeSource(
      ctx.tenantId,
      admitted!.confirmed_target_id!,
      ctx.testDb.db,
    );
    expect(source?.source_type).toBe("bundle");
    const sourceVersion = source?.version;
    const admittedItem = await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db);
    expect(admittedItem?.state).toBe("admitted");

    await expect(
      patchIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: item.id,
          expected_version: admittedItem!.version,
          state: "discarded",
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    expect(await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db)).toMatchObject({
      state: "admitted",
      version: admittedItem!.version,
      original_snapshot: admittedItem!.original_snapshot,
    });

    const annotated = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: admittedItem!.version,
        note: "Confirmed source remains traceable.",
      },
      ctx.testDb.db,
    );
    const moved = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: annotated!.version,
        category: "archive",
      },
      ctx.testDb.db,
    );
    expect(moved).toMatchObject({
      state: "admitted",
      category: "archive",
      original_snapshot: admittedItem!.original_snapshot,
    });
    expect(
      (await getKnowledgeSource(ctx.tenantId, admitted!.confirmed_target_id!, ctx.testDb.db))
        ?.version,
    ).toBe(sourceVersion);

    const retry = await confirmIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: revised!.current_revision,
        digest: revised!.revision.digest,
      },
      ctx.testDb.db,
    );
    expect(retry?.confirmed_target_id).toBe(admitted?.confirmed_target_id);
  });

  test("allows discard and restore while invalidating the prior proposal revision", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Recording workflow",
        body: "Keep the source for later review.",
        target: { name: "Recording workflow" },
      },
      ctx.testDb.db,
    );
    const discarded = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        state: "discarded",
      },
      ctx.testDb.db,
    );
    const restored = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: discarded!.version,
        state: "collected",
      },
      ctx.testDb.db,
    );
    expect(restored).toMatchObject({ state: "collected", version: item.version + 2 });
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
  });

  test("fails closed when an existing knowledge target changes after review", async () => {
    const target = await upsertKnowledgeBundle(
      {
        tenant_id: ctx.tenantId,
        actor,
        input: { name: "Recording reference" },
        files: [{ path: "/reference.md", content: "# Recording reference\n" }],
      },
      ctx.testDb.db,
    );
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Add recording workflow",
        body: "Keep the raw and processed takes together.",
        target: {
          knowledge_source_id: target.knowledge_source.id,
          expected_version: target.knowledge_source.version,
        },
      },
      ctx.testDb.db,
    );
    await upsertKnowledgeBundle(
      {
        tenant_id: ctx.tenantId,
        actor,
        input: { name: "Recording reference", slug: target.knowledge_source.slug },
        files: [{ path: "/reference.md", content: "# Changed reference\n" }],
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
    expect((await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db))?.state).toBe("reviewing");
  });

  test("serializes concurrent confirmation into one knowledge publication", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Concurrent recording workflow",
        body: "Preserve both takes.",
        target: { name: "Concurrent recording knowledge" },
      },
      ctx.testDb.db,
    );
    const request = {
      tenant_id: ctx.tenantId,
      actor,
      id: proposal.id,
      expected_revision: proposal.current_revision,
      digest: proposal.revision.digest,
    };
    const [first, second] = await Promise.all([
      confirmIntakeProposal(request, ctx.testDb.db),
      confirmIntakeProposal(request, ctx.testDb.db),
    ]);
    expect(first?.status).toBe("confirmed");
    expect(second?.confirmed_target_id).toBe(first?.confirmed_target_id);
    expect(
      await listKnowledgeSources(
        { tenant_id: ctx.tenantId, q: "Concurrent recording knowledge" },
        ctx.testDb.db,
      ),
    ).toHaveLength(1);
  });

  test("admits reviewed category and tags with a new knowledge bundle", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Recording workflow guidance",
        body: "Preserve both takes for later comparison.",
        target: {
          name: "Recording workflow guidance",
          category: "product",
          tags: ["recording", "workflow"],
        },
      },
      ctx.testDb.db,
    );
    const admitted = await confirmIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        digest: proposal.revision.digest,
      },
      ctx.testDb.db,
    );
    const source = await getKnowledgeSource(
      ctx.tenantId,
      admitted?.confirmed_target_id ?? "",
      ctx.testDb.db,
    );
    expect(source?.category).toBe("product");
    expect(source?.tags).toEqual(["recording", "workflow"]);
  });

  test("requires a fresh confirmation when a proposed target classification changes", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Classified recording workflow",
        body: "Preserve the original source.",
        target: { name: "Classified recording workflow", category: "product", tags: ["audio"] },
      },
      ctx.testDb.db,
    );
    const revised = await reviseIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        item_ids: [item.id],
        title: "Classified recording workflow",
        body: "Preserve the original source.",
        target: {
          name: "Classified recording workflow",
          category: "product",
          tags: ["audio", "workflow"],
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
    ).rejects.toBeInstanceOf(IntakeProposalConflictError);
    expect(revised?.revision.target).toEqual({
      name: "Classified recording workflow",
      category: "product",
      tags: ["audio", "workflow"],
    });
  });

  test("rejects cross-tenant proposal targets and confirmations", async () => {
    const item = await createClip();
    const [otherTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({
        slug: `t-intake-proposal-${nextUuid().slice(0, 8)}`,
        display_name: "Other proposal tenant",
      })
      .returning();
    if (!otherTenant) throw new Error("other tenant insertion failed");
    const otherTarget = await upsertKnowledgeBundle(
      {
        tenant_id: otherTenant.id,
        actor,
        input: { name: "Other tenant target" },
        files: [{ path: "/other.md", content: "# Other\n" }],
      },
      ctx.testDb.db,
    );
    await expect(
      createIntakeProposal(
        {
          tenant_id: otherTenant.id,
          actor,
          item_ids: [item.id],
          title: "Cross tenant item",
          body: "Never allowed.",
          target: { name: "Other knowledge" },
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    await expect(
      createIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          item_ids: [item.id],
          title: "Cross tenant target",
          body: "Never allowed.",
          target: {
            knowledge_source_id: otherTarget.knowledge_source.id,
            expected_version: otherTarget.knowledge_source.version,
          },
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeNotFoundError);
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Tenant-local proposal",
        body: "Await the local reviewer.",
        target: { name: "Tenant-local knowledge" },
      },
      ctx.testDb.db,
    );
    expect(
      await confirmIntakeProposal(
        {
          tenant_id: otherTenant.id,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
        },
        ctx.testDb.db,
      ),
    ).toBeNull();
    expect((await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db))?.state).toBe("reviewing");
  });
});

describe.skipIf(skip)("session intake and skill targets", () => {
  function sessionInput(
    overrides: Partial<Parameters<typeof createSessionIntakeItem>[0]> = {},
    session: Partial<Parameters<typeof createSessionIntakeItem>[0]["session"]> = {},
  ): Parameters<typeof createSessionIntakeItem>[0] {
    return {
      tenant_id: ctx.tenantId,
      actor,
      title: "Draft Jira tickets in chat first",
      body: "Write the ticket text in chat and let the person approve it before filing.",
      captured_at: "2026-10-10T07:00:00.000Z",
      ...overrides,
      session: {
        agent: "claude-code",
        session_id: `session-${nextUuid()}`,
        repo: "example/repo",
        domains: [],
        evidence_excerpt: "The person asked to see the ticket text before filing it.",
        ...session,
      },
    };
  }

  async function newSkill(title: string) {
    return createSkill(
      {
        tenant_id: ctx.tenantId,
        input: { scope: "global", title, body: `${title} guidance`, status: "active" },
      },
      ctx.testDb.db,
    );
  }

  async function sessionItem(title: string) {
    return (await createSessionIntakeItem(sessionInput({ title }), ctx.testDb.db)).item;
  }

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
