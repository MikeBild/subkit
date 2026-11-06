import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations } from "../db/schema/index.ts";
import { createEmptyState, normalizeState } from "./authoring-state/normalize.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { computeGroundingStatus } from "./grounding-staleness.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./tests/setup.ts";
import type { DraftDocument } from "./types.ts";

const fixedClock = () => "2026-11-06T00:00:00.000Z";

describe("grounding-staleness · provenance survives normalize", () => {
  test("grounding_fingerprint AND grounding_connector_ids survive the round-trip", () => {
    const state = createEmptyState("workflow");
    state.grounding_fingerprint = "0011223344556677";
    state.grounding_connector_ids = ["c-1", "c-2"];
    const revived = normalizeState({ state }, undefined, fixedClock);
    expect(revived.grounding_fingerprint).toBe("0011223344556677");
    expect(revived.grounding_connector_ids).toEqual(["c-1", "c-2"]);
  });

  test("a non-array grounding_connector_ids normalizes to null", () => {
    const revived = normalizeState(
      { state: { grounding_fingerprint: "x", grounding_connector_ids: "nope" } },
      undefined,
      fixedClock,
    );
    expect(revived.grounding_connector_ids).toBeNull();
  });

  test("non-string entries are filtered out", () => {
    const revived = normalizeState(
      { state: { grounding_connector_ids: ["c-1", 42, null, "c-2"] } },
      undefined,
      fixedClock,
    );
    expect(revived.grounding_connector_ids).toEqual(["c-1", "c-2"]);
  });
});

describe("grounding-staleness · computeGroundingStatus fail-open", () => {
  let ctx: ConversationTestCtx;
  beforeAll(async () => {
    ctx = await createConversationTestCtx("grounding_staleness");
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  async function seedDraft(state: DraftDocument["state"]): Promise<string> {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", loaded_skills: [] })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await appendSnapshot(
      ctx.tenant_id,
      conv.id,
      { workflow: { name: "wf", steps: [] }, state } as unknown as DraftDocument,
      ctx.testDb.db,
    );
    return conv.id;
  }

  test("no grounding fingerprint → null (no advisory possible)", async () => {
    const id = await seedDraft(createEmptyState("workflow"));
    const draft = await loadDraft(ctx.tenant_id, id, ctx.testDb.db);
    expect(await computeGroundingStatus(ctx.tenant_id, draft, ctx.testDb.db)).toBeNull();
  });

  test("fingerprint but no connector set → unknown, never a false stale", async () => {
    const state = createEmptyState("workflow");
    state.grounding_fingerprint = "abcdef0123456789";
    const id = await seedDraft(state);
    const draft = await loadDraft(ctx.tenant_id, id, ctx.testDb.db);
    const status = await computeGroundingStatus(ctx.tenant_id, draft, ctx.testDb.db);
    expect(status).toEqual({ state: "unknown", advisory: null });
  });

  test("connector set with no discoverable schema → unknown (fail-open), not stale", async () => {
    const state = createEmptyState("workflow");
    state.grounding_fingerprint = "abcdef0123456789";
    state.grounding_connector_ids = [ctx.connector_id];
    const id = await seedDraft(state);
    const draft = await loadDraft(ctx.tenant_id, id, ctx.testDb.db);
    const status = await computeGroundingStatus(ctx.tenant_id, draft, ctx.testDb.db);
    expect(status).toEqual({ state: "unknown", advisory: null });
  });
});
