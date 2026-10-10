import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { renameCategory } from "../../workflows/catalog-view.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource, listKnowledgeSources } from "../catalog.ts";
import {
  confirmIntakeProposal,
  createIntakeItem,
  createIntakeProposal,
  getIntakeItem,
  getIntakeProposal,
  listIntakeCategories,
  patchIntakeItem,
  reviseIntakeProposal,
} from "../intake.ts";
import {
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeProposalConflictError,
} from "../intake-errors.ts";
import { searchKnowledge } from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";
const nextUuid = createDeterministicUuidFactory(0x1a2b_3c4d);
const actor = { kind: "system_account" as const, id: nextUuid() };
let ctx: KnowledgeTestCtx;

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
    expect(admitted?.confirmed_knowledge_source_id).toBeDefined();
    const source = await getKnowledgeSource(
      ctx.tenantId,
      admitted!.confirmed_knowledge_source_id!,
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
      (
        await getKnowledgeSource(
          ctx.tenantId,
          admitted!.confirmed_knowledge_source_id!,
          ctx.testDb.db,
        )
      )?.version,
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
    expect(retry?.confirmed_knowledge_source_id).toBe(admitted?.confirmed_knowledge_source_id);
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
    expect(second?.confirmed_knowledge_source_id).toBe(first?.confirmed_knowledge_source_id);
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
      admitted?.confirmed_knowledge_source_id ?? "",
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
