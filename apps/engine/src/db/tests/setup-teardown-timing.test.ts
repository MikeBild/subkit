import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("teardown-timing");
});

afterAll(async () => {
  try {
    await ctx.cleanup();
  } catch {}
});

test("uncontended testcontainer teardown completes in under 5 seconds", async () => {
  const tmp = await createTestDb("teardown-timing-inner");
  const startedAt = performance.now();
  await tmp.cleanup();
  const elapsed = performance.now() - startedAt;
  expect(elapsed).toBeLessThan(5_000);
});
