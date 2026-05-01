// Tenant-authored skill activation. Pins the contract that an
// operator-supplied skill (one with `activates_when` set on its row,
// not seeded from disk) is loaded by `loadActivationCatalog` and
// matched by `autoloadForToolCall` exactly like a shipped skill —
// proving the data-driven path is functional for non-shipped skills.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skills, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { autoloadForToolCall, loadActivationCatalog } from "./skill-autoload.ts";

const skip = process.env.SKIP_DB_TESTS === "1";
let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("skill-autoload-tenant");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "salt", display_name: "salt" })
    .returning();
  tenant_id = t!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("loadActivationCatalog + autoloadForToolCall — tenant-authored", () => {
  test("a tenant skill with activates_when is matched on the right tool call", async () => {
    await ctx.db.insert(skills).values({
      tenant_id,
      slug: "tenant-stripe-policy",
      scope: "global",
      title: "Tenant Stripe Policy",
      body: "internal note",
      examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
      lifecycle: "active",
      source: "manual",
      version: 1,
      side_effects: "read",
      activates_when: [{ kind: "tool", tool: "propose_step" }],
      gates_tools: [],
      tags: [],
    });

    const catalog = await loadActivationCatalog(tenant_id, ctx.db);
    const slugs = catalog.map((c) => c.slug);
    expect(slugs).toContain("tenant-stripe-policy");

    const out = autoloadForToolCall(
      { tool: "propose_step", input: { step: { kind: "request" } } },
      catalog,
      [],
    );
    expect(out).toContain("tenant-stripe-policy");
  });

  test("experimental tenant skill is excluded from the catalog", async () => {
    await ctx.db.insert(skills).values({
      tenant_id,
      slug: "tenant-experimental",
      scope: "global",
      title: "Experimental",
      body: "wip",
      examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
      lifecycle: "active",
      source: "manual",
      version: 1,
      side_effects: "read",
      maturity: "experimental",
      activates_when: [{ kind: "tool", tool: "propose_step" }],
      gates_tools: [],
      tags: [],
    });

    const catalog = await loadActivationCatalog(tenant_id, ctx.db);
    expect(catalog.find((c) => c.slug === "tenant-experimental")).toBeUndefined();
  });

  test("archived tenant skill is excluded from the catalog", async () => {
    await ctx.db.insert(skills).values({
      tenant_id,
      slug: "tenant-archived",
      scope: "global",
      title: "Archived",
      body: "old",
      examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
      lifecycle: "archived",
      source: "manual",
      version: 1,
      side_effects: "read",
      activates_when: [{ kind: "tool", tool: "probe_connector" }],
      gates_tools: [],
      tags: [],
    });

    const catalog = await loadActivationCatalog(tenant_id, ctx.db);
    expect(catalog.find((c) => c.slug === "tenant-archived")).toBeUndefined();
  });
});
