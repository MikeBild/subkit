// createWorkflow on a duplicate active slug must return a clean conflict
// result — NOT throw a raw Postgres 23505 that surfaces as an unhandled 500.
// Observed in prod runtime logs: a duplicate-slug POST /v1/workflows logged
// `request.failed: unhandled error … Failed query: insert into "workflows"`
// and returned `{"code":"internal_error"}` (HTTP 500).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createWorkflow } from "../service.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("create_slug_conflict");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-slugconf", display_name: "T-SLUGCONF" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

const def = (slug: string) => ({
  name: slug,
  slug,
  steps: [{ id: "t", kind: "transform", language: "javascript", expression: "return input;" }],
});

describe("createWorkflow — duplicate slug conflict", () => {
  test("second create with the same active slug returns a clean conflict, not a 500", async () => {
    const first = await createWorkflow({ tenant_id, def: def("dup-slug"), actor_id: null }, ctx.db);
    expect("workflow" in first).toBe(true);

    // The bug: this threw a raw 23505 out of the transaction → unhandled 500.
    // The fix: it resolves to a structured `{ errors }` the route maps to a 4xx.
    let second: Awaited<ReturnType<typeof createWorkflow>>;
    let threw = false;
    try {
      second = await createWorkflow({ tenant_id, def: def("dup-slug"), actor_id: null }, ctx.db);
    } catch {
      threw = true;
      second = { errors: ["threw"] };
    }
    expect(threw).toBe(false);
    expect("errors" in second).toBe(true);
    const errors = (second as { errors: string[] }).errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("dup-slug");
    expect(errors[0]!.toLowerCase()).toContain("already");
  });

  test("a genuinely new slug still creates normally (no false conflict)", async () => {
    const res = await createWorkflow({ tenant_id, def: def("fresh-slug"), actor_id: null }, ctx.db);
    expect("workflow" in res).toBe(true);
  });
});
