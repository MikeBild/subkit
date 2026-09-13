// Draft-snapshot LRU + retrieval tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  countDraftSnapshots,
  createDraftSnapshot,
  DRAFT_SNAPSHOT_LRU_CAP,
  getDraftSnapshot,
  listDraftSnapshots,
} from "../draft-checkpoints.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("draft_checkpoints");
  const [t] = await ctx.db.insert(tenants).values({ slug: "t-dcp", display_name: "T" }).returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = c!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function sampleDraft(n: number): DraftDocument {
  return {
    workflow: {
      name: `draft-${n}`,
      slug: `d${n}`,
      steps: [{ id: "a", kind: "wait", duration_ms: n }] as Array<Record<string, unknown>>,
    },
  };
}

describe("createDraftSnapshot", () => {
  test("inserts row with correct fields and returns id", async () => {
    const snap = await createDraftSnapshot(
      {
        tenant_id,
        conversation_id,
        turn_index: 1,
        draft: sampleDraft(1),
        label: "first",
      },
      ctx.db,
    );
    expect(snap.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(snap.label).toBe("first");
    expect(snap.turn_index).toBe(1);
    expect(snap.draft.workflow.name).toBe("draft-1");
  });

  test("prunes oldest rows beyond LRU cap", async () => {
    // Reset: recreate conversation so we start from a clean count
    const [c] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const convId = c!.id;

    // Insert LRU_CAP + 3 snapshots; the 3 oldest must be pruned.
    for (let i = 1; i <= DRAFT_SNAPSHOT_LRU_CAP + 3; i++) {
      await createDraftSnapshot(
        {
          tenant_id,
          conversation_id: convId,
          turn_index: i,
          draft: sampleDraft(i),
        },
        ctx.db,
      );
    }
    const countAfter = await countDraftSnapshots({ tenant_id, conversation_id: convId }, ctx.db);
    expect(countAfter).toBe(DRAFT_SNAPSHOT_LRU_CAP);
    const rows = await listDraftSnapshots({ tenant_id, conversation_id: convId }, ctx.db);
    const turnIndices = rows.map((r) => r.turn_index).sort((a, b) => a - b);
    // The 3 smallest turn_indexes should be gone.
    expect(turnIndices[0]).toBe(4);
    expect(turnIndices.at(-1)).toBe(DRAFT_SNAPSHOT_LRU_CAP + 3);
  });
});

describe("listDraftSnapshots + getDraftSnapshot", () => {
  test("list returns newest-first", async () => {
    const [c] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const convId = c!.id;
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const s = await createDraftSnapshot(
        {
          tenant_id,
          conversation_id: convId,
          turn_index: i,
          draft: sampleDraft(i),
        },
        ctx.db,
      );
      ids.push(s.id);
      await new Promise((r) => setTimeout(r, 5)); // allow-wall-clock: draft-snapshot persistence ordering across appendSnapshot calls
    }
    const rows = await listDraftSnapshots({ tenant_id, conversation_id: convId }, ctx.db);
    // Newest first == reverse of insert order.
    expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
  });

  test("get returns the exact draft payload", async () => {
    const snap = await createDraftSnapshot(
      {
        tenant_id,
        conversation_id,
        turn_index: 99,
        draft: sampleDraft(99),
        label: "target",
      },
      ctx.db,
    );
    const got = await getDraftSnapshot({ tenant_id, snapshot_id: snap.id }, ctx.db);
    expect(got).not.toBeNull();
    expect(got!.label).toBe("target");
    expect(got!.draft.workflow.name).toBe("draft-99");
  });

  test("get with wrong tenant returns null (isolation)", async () => {
    const [otherT] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-dcp-other", display_name: "X" })
      .returning();
    const snap = await createDraftSnapshot(
      {
        tenant_id,
        conversation_id,
        turn_index: 1,
        draft: sampleDraft(1),
      },
      ctx.db,
    );
    const leaked = await getDraftSnapshot({ tenant_id: otherT!.id, snapshot_id: snap.id }, ctx.db);
    expect(leaked).toBeNull();
  });
});
