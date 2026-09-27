// GET /v1/connectors?health=not_ok — the list a red connector-health tile opens.
//
// The cockpit used to read 200 enabled connectors and filter them itself, so
// past 200 the list was short and its total counted rows it then hid. The
// narrowing is the engine's now, with the ratio's own predicate
// (`connectorCountsAgainstHealth`): what the ratio counts against, the list
// holds — with a total and pages that describe the narrowed list.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors } from "../../../db/schema/index.ts";
import {
  getOperationalOverview,
  invalidateOperationalOverview,
} from "../../../operator/operational-overview.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
const notOk = new Set<string>();

async function list(query: string): Promise<{ items: { id: string }[]; total: number }> {
  const res = await fetch(`${ctx.baseUrl}/v1/connectors?${query}`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { items: { id: string }[]; total: number };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("connector_health_filter");
  const seed = (
    slug: string,
    health_state: string,
    extra: { enabled?: boolean; deleted_at?: Date } = {},
  ) => ({
    tenant_id: ctx.tenantId,
    slug,
    display_name: slug,
    driver: "http",
    environment: "prod" as const,
    base_url: `https://${slug}.example.test`,
    health_state,
    ...extra,
  });
  const rows = await ctx.db
    .insert(connectors)
    .values([
      seed("healthy", "ok"),
      seed("reauth", "needs_reauth"),
      seed("degraded", "degraded"),
      seed("outdated", "needs_update"),
      // Not in the ratio at all: switched off, or gone.
      seed("switched-off", "degraded", { enabled: false }),
      seed("removed", "degraded", { deleted_at: new Date(getTestNow()) }),
    ])
    .returning({ id: connectors.id, slug: connectors.slug });
  for (const row of rows)
    if (["reauth", "degraded", "outdated"].includes(row.slug)) notOk.add(row.id);
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

test("health=not_ok lists exactly the enabled connectors that are not ok", async () => {
  const body = await list("health=not_ok&limit=50");
  expect(body.total).toBe(3);
  expect(new Set(body.items.map((item) => item.id))).toEqual(notOk);
});

test("the total counts the narrowed list, and a page is a page of it", async () => {
  const page = await list("health=not_ok&limit=1&offset=1&sort=name&order=asc");
  expect(page.total).toBe(3);
  expect(page.items).toHaveLength(1);
  expect(notOk.has(page.items[0]?.id ?? "")).toBe(true);
});

test("health=not_ok beside enabled=false is an empty list, not the disabled ones", async () => {
  const body = await list("health=not_ok&enabled=false");
  expect(body.total).toBe(0);
  expect(body.items).toEqual([]);
});

test("the list holds what the overview's connector-health ratio counts against", async () => {
  invalidateOperationalOverview(ctx.tenantId);
  const overview = await getOperationalOverview(ctx.db, ctx.tenantId);
  const component = overview.core.health.components.find(
    (c) => c.id === "connectors.healthy_ratio",
  );
  // Four counted (the disabled and the deleted are not), one healthy.
  expect(component?.raw_value).toBe(1 / 4);
  const body = await list("health=not_ok");
  expect(body.total).toBe(4 - 1);
  const causes = overview.core.health.causes.filter((cause) => cause.kind === "connector");
  expect(new Set(causes.map((cause) => cause.id))).toEqual(notOk);
});
