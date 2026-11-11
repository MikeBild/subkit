import { describe, expect, test } from "bun:test";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource } from "../catalog.ts";
import { getKnowledgeSourceContent } from "../content.ts";
import {
  createIntakeProposal,
  getIntakeItem,
  getIntakeProposal,
  patchIntakeItem,
  reviseIntakeProposal,
} from "../index.ts";
import { proposalDigest } from "../intake-digest.ts";
import {
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeProposalConflictError,
} from "../intake-errors.ts";
import {
  actor,
  confirmIntakeProposal,
  createClip,
  ctx,
  nextUuid,
  skip,
  useKnowledgeIntakeDb,
} from "./intake-fixtures.ts";

async function holdIntakeItems(...ids: string[]) {
  const client = await ctx.testDb.pool.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT id FROM subkit.intake_items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [ids],
  );
  return {
    async release() {
      await client.query("COMMIT");
      client.release();
    },
    async rollback() {
      await client.query("ROLLBACK");
      client.release();
    },
  };
}

async function waitForIntakeLockWaiters(count: number) {
  await waitFor(
    async () => {
      const result = await ctx.testDb.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%intake_items%'",
      );
      return Number(result.rows[0]?.count ?? 0) >= count;
    },
    { label: "intake lock waiters", sleepMs: 2 },
  );
}

useKnowledgeIntakeDb();

describe.skipIf(skip)("knowledge intake", () => {
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

  test("keeps the clip source address, author and publication date in admitted knowledge", async () => {
    const item = await createClip({
      title: "Video [talk] on recording",
      source_url: "https://video.example.test/watch?v=abc",
      source_author: "Channel Author",
      published_at: "2026-09-01",
    });
    const note = await createClip({
      title: "Loose note",
      source_url: undefined,
      source_author: undefined,
      published_at: undefined,
    });
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id, note.id],
        title: "Recording talk summary",
        body: "Model-written summary of the talk.",
        target: { name: "Recording talk summary" },
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
    const content = await getKnowledgeSourceContent(
      ctx.tenantId,
      admitted?.confirmed_target_id ?? "",
      ctx.testDb.db,
    );
    const document = content?.documents.find((entry) => entry.path === `/intake/${proposal.id}.md`);
    expect(document?.content).toBe(
      [
        "# Recording talk summary",
        "",
        "Model-written summary of the talk.",
        "",
        "## Sources",
        "",
        "- [Video \\[talk\\] on recording](<https://video.example.test/watch?v=abc>) · Author: Channel Author · Published: 2026-09-01",
        "",
      ].join("\n"),
    );
  });

  test("shows the clip author and publication date in the proposal without changing its digest", async () => {
    const item = await createClip({
      title: "Talk on recording",
      source_url: "https://video.example.test/watch?v=def",
      source_author: "Channel Author",
      published_at: "2026-09-02",
    });
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Talk summary",
        body: "Summary.",
        target: { name: "Talk summary" },
      },
      ctx.testDb.db,
    );
    const [shown] = proposal.revision.items;
    expect(shown).toMatchObject({
      id: item.id,
      source_url: "https://video.example.test/watch?v=def",
      source_author: "Channel Author",
      published_at: "2026-09-02",
    });
    const reread = await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db);
    expect(reread?.revision.items[0]).toMatchObject({
      source_author: "Channel Author",
      published_at: "2026-09-02",
    });
    expect(proposal.revision.digest).toBe(
      proposalDigest({
        title: "Talk summary",
        body: "Summary.",
        target: { name: "Talk summary" },
        items: [
          {
            id: item.id,
            version: item.version,
            title: "Talk on recording",
            source_url: "https://video.example.test/watch?v=def",
          },
        ],
      }),
    );
  });

  test("confirming one proposal makes every other open proposal for its entry stale", async () => {
    const item = await createClip({ title: "Entry with two proposals" });
    const other = await createClip({ title: "Untouched entry" });
    const make = (title: string, itemIds: string[]) =>
      createIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          item_ids: itemIds,
          title,
          body: `${title} body.`,
          target: { name: title },
        },
        ctx.testDb.db,
      );
    const first = await make("First proposal", [item.id]);
    const second = await make("Second proposal", [item.id]);
    const unrelated = await make("Unrelated proposal", [other.id]);
    await confirmIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: first.id,
        expected_revision: first.current_revision,
        digest: first.revision.digest,
      },
      ctx.testDb.db,
    );
    expect(await getIntakeProposal(ctx.tenantId, first.id, ctx.testDb.db)).toMatchObject({
      status: "confirmed",
    });
    expect(await getIntakeProposal(ctx.tenantId, second.id, ctx.testDb.db)).toMatchObject({
      status: "stale",
      stale_reason: "intake_item_admitted",
    });
    expect(await getIntakeProposal(ctx.tenantId, unrelated.id, ctx.testDb.db)).toMatchObject({
      status: "draft",
      stale_reason: null,
    });
    await expect(
      confirmIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: second.id,
          expected_revision: second.current_revision,
          digest: second.revision.digest,
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow("proposal must be reviewed again before confirmation");
  });

  test("serializes sibling confirmations that share an intake item", async () => {
    const item = await createClip({ title: "Shared confirmation source" });
    const create = (title: string) =>
      createIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          item_ids: [item.id],
          title,
          body: `${title} body.`,
          target: { name: title },
        },
        ctx.testDb.db,
      );
    const [first, second] = await Promise.all([create("First sibling"), create("Second sibling")]);
    const confirm = (proposal: typeof first) =>
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
    const blocker = await holdIntakeItems(item.id);
    let outcomes!: PromiseSettledResult<Awaited<ReturnType<typeof confirm>>>[];
    let released = false;
    try {
      const pending = Promise.allSettled([confirm(first), confirm(second)]);
      await waitForIntakeLockWaiters(2);
      await blocker.release();
      released = true;
      outcomes = await pending;
    } catch (error) {
      if (!released) await blocker.rollback();
      throw error;
    }
    expect(
      outcomes.filter(
        (outcome) => outcome.status === "fulfilled" && outcome.value?.status === "confirmed",
      ),
    ).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" && outcome.reason instanceof IntakeProposalConflictError,
      ),
    ).toHaveLength(1);
    const proposals = await Promise.all([
      getIntakeProposal(ctx.tenantId, first.id, ctx.testDb.db),
      getIntakeProposal(ctx.tenantId, second.id, ctx.testDb.db),
    ]);
    expect(proposals.filter((proposal) => proposal?.status === "confirmed")).toHaveLength(1);
    expect(
      proposals.filter((proposal) => proposal?.stale_reason === "intake_item_admitted"),
    ).toHaveLength(1);
  });

  test("serializes an item edit ahead of a waiting confirmation", async () => {
    const item = await createClip({ title: "Editable confirmation source" });
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Editable source proposal",
        body: "Review the source before admission.",
        target: { name: "Editable source knowledge" },
      },
      ctx.testDb.db,
    );
    const blocker = await holdIntakeItems(item.id);
    let released = false;
    try {
      const patch = patchIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: item.id,
          expected_version: item.version,
          body: "The source changed before admission.",
        },
        ctx.testDb.db,
      );
      await waitForIntakeLockWaiters(1);
      const confirmation = confirmIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
        },
        ctx.testDb.db,
      );
      const confirmationOutcome = Promise.allSettled([confirmation]);
      await waitForIntakeLockWaiters(2);
      await blocker.release();
      released = true;
      await expect(patch).resolves.toMatchObject({ version: item.version + 1 });
      expect(await confirmationOutcome).toEqual([
        { status: "rejected", reason: expect.any(IntakeProposalConflictError) },
      ]);
    } catch (error) {
      if (!released) await blocker.rollback();
      throw error;
    }
    expect(await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db)).toMatchObject({
      status: "stale",
      stale_reason: "intake_item_changed",
    });
  });

  test("serializes reversed multi-item confirmation order", async () => {
    const [firstItem, secondItem] = await Promise.all([createClip(), createClip()]);
    const create = (title: string, item_ids: string[]) =>
      createIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          item_ids,
          title,
          body: `${title} body.`,
          target: { name: title },
        },
        ctx.testDb.db,
      );
    const [first, second] = await Promise.all([
      create("Forward items", [firstItem.id, secondItem.id]),
      create("Reverse items", [secondItem.id, firstItem.id]),
    ]);
    const blocker = await holdIntakeItems(firstItem.id, secondItem.id);
    let released = false;
    try {
      const pending = Promise.allSettled(
        [first, second].map((proposal) =>
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
        ),
      );
      await waitForIntakeLockWaiters(2);
      await blocker.release();
      released = true;
      const outcomes = await pending;
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(
        outcomes.filter(
          (outcome) =>
            outcome.status === "rejected" && outcome.reason instanceof IntakeProposalConflictError,
        ),
      ).toHaveLength(1);
    } catch (error) {
      if (!released) await blocker.rollback();
      throw error;
    }
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
    const otherTenant = await seedTenant(ctx.testDb.db, {
      slug: `t-intake-proposal-${nextUuid().slice(0, 8)}`,
      display_name: "Other proposal tenant",
    });
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
