import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { resolveConnectors } from "../authoring-grounding.ts";

let db: TestDb;
let tenant_id: string;
let live_id: string;

beforeAll(async () => {
  db = await createTestDb("authoring_grounding_deleted");
  const [tenant] = await db.db
    .insert(tenants)
    .values({ slug: "t-grounding-deleted", display_name: "T" })
    .returning();
  tenant_id = tenant!.id;
  const base: typeof connectors.$inferInsert = {
    tenant_id,
    slug: "open-meteo",
    display_name: "Open-Meteo",
    driver: "http",
    environment: "dev",
    auth_type: "none",
    base_url: "https://api.open-meteo.com",
    config: {},
  };
  await db.db.insert(connectors).values({ ...base, deleted_at: new Date(FROZEN_NOW) });
  const [live] = await db.db.insert(connectors).values(base).returning();
  live_id = live!.id;
});

afterAll(async () => {
  await db.cleanup();
});

test("a deleted connector with the same slug never makes authoring ambiguous", async () => {
  const bySlug = await resolveConnectors({ db: db.db, tenant_id }, ["open-meteo"]);
  expect(bySlug.resolved.map((c) => c.id)).toEqual([live_id]);
});
