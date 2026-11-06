import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, intakeItemEvidence, intakeProposalItems } from "../../db/schema/index.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource, listKnowledgeSources } from "../catalog.ts";
import {
  createIntakeProposal,
  deleteDiscardedIntakeItem,
  getIntakeItem,
  getIntakeProposal,
  listIntakeItems,
  patchIntakeItem,
  reviseIntakeProposal,
} from "../index.ts";
import { IntakeConflictError, IntakeProposalConflictError } from "../intake-errors.ts";
import {
  actor,
  confirmIntakeProposal,
  createClip,
  ctx,
  nextUuid,
  skip,
  useKnowledgeIntakeDb,
} from "./intake-fixtures.ts";

useKnowledgeIntakeDb();

describe.skipIf(skip)("knowledge intake", () => {
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
    await expect(
      deleteDiscardedIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: item.id,
          expected_version: admittedItem!.version,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);

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

  test("permanently deletes discarded raw intake and detaches its stale proposal references", async () => {
    const item = await createClip({ category: "intake-test" });
    await expect(
      deleteDiscardedIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: item.id,
          expected_version: item.version,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    expect(
      await deleteDiscardedIntakeItem(
        {
          tenant_id: nextUuid(),
          actor,
          id: item.id,
          expected_version: item.version,
        },
        ctx.testDb.db,
      ),
    ).toBe(false);
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Discarded recording workflow",
        body: "This proposal must retain its decision history without raw clip references.",
        target: { name: "Discarded recording workflow" },
      },
      ctx.testDb.db,
    );
    await ctx.testDb.db.insert(intakeItemEvidence).values({
      tenant_id: ctx.tenantId,
      item_id: item.id,
      agent: "test-agent",
      session_id: nextUuid(),
      repo: "subkit",
      excerpt: "Raw evidence that must be removed with the discarded intake item.",
      captured_at: new Date("2026-10-10T07:00:00.000Z"),
      recorded_by_type: actor.kind,
      recorded_by_id: actor.id,
    });
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
    await expect(
      deleteDiscardedIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: item.id,
          expected_version: item.version,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    expect(
      await deleteDiscardedIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: item.id,
          expected_version: discarded!.version,
        },
        ctx.testDb.db,
      ),
    ).toBe(true);
    expect(await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db)).toBeNull();
    expect(
      (await listIntakeItems({ tenant_id: ctx.tenantId }, ctx.testDb.db)).map(({ id }) => id),
    ).not.toContain(item.id);
    expect(
      await ctx.testDb.db
        .select()
        .from(intakeItemEvidence)
        .where(eq(intakeItemEvidence.item_id, item.id)),
    ).toEqual([]);
    expect(
      await ctx.testDb.db
        .select()
        .from(intakeProposalItems)
        .where(eq(intakeProposalItems.item_id, item.id)),
    ).toEqual([]);
    expect(await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db)).toMatchObject({
      status: "stale",
      revision: { items: [] },
    });
    const [audit] = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "intake_item.deleted"),
          eq(auditLog.resource_id, item.id),
        ),
      );
    expect(audit?.metadata).toMatchObject({
      category: "intake-test",
      origin: "capture",
      detached_proposal_items: 1,
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain("original clip says useful things");
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
});
