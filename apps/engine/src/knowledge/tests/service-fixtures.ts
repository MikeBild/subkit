import { afterAll, beforeAll } from "bun:test";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

export const skip = process.env.REQUIRES_PG === "0";

export const nextUuid = createDeterministicUuidFactory(0x6b10_20);

export let ctx: KnowledgeTestCtx;

export function useKnowledgeServiceDb(): void {
  beforeAll(async () => {
    if (skip) return;
    ctx = await createKnowledgeTestCtx("svc");
  }, 60_000);
  afterAll(async () => {
    if (!skip && ctx?.cleanup) await ctx.cleanup();
  }, TEST_DB_HOOK_TIMEOUT);
}
