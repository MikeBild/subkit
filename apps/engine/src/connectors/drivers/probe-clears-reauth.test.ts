// A successful probe closes the re-auth state machine's clearing edge.
//
// `connectors/reauth.ts` documents the machine as
//   healthy ──auth failure──▶ needs_reauth=true
//   needs_reauth=true ──successful authed call──▶ healthy
// but nothing used to walk the second edge except a workflow step, and the
// flag itself makes workflow steps unavailable: `workflows/effect-resolution.ts`
// lists every step on a flagged connector as unavailable (holding the schedule)
// and `execution/prepared-workflow-references.ts` refuses the prepared run that
// would have made the healing call. A connector flagged in error was therefore
// stranded, with a live credential, until a human re-authenticated it.
//
// A probe is a successful authenticated call, so it now clears the flag. These
// tests pin the edge and its two guards: a failed probe proves nothing, and a
// draft probe (`credential_override`) proves something about the material the
// caller supplied, not about the persisted row.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { markConnectorNeedsReauth } from "../reauth.ts";
import { createConnector, getConnector } from "../service.ts";
import type { ConnectorView } from "../types.ts";
import { probeConnector } from "./index.ts";

let ctx: TestDb;
let tenantId: string;
let mock: MockServer;
/** Flipped per test so one fixture can answer healthy or reject the credential. */
let probeStatus = 200;

beforeAll(async () => {
  ctx = await createTestDb("probe-clears-reauth");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "probe-clears-reauth", display_name: "Probe clears reauth" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  mock = await createMockServer((_req: IncomingMessage, res: ServerResponse) => {
    jsonResponse(res, probeStatus, probeStatus === 200 ? { ok: true } : { error: "nope" });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

/** A flagged bearer connector with a real stored credential, as a probe sees it. */
async function seedFlaggedConnector(name: string): Promise<ConnectorView> {
  const created = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name,
        driver: "http",
        environment: "dev",
        base_url: mock.baseUrl,
        auth_type: "bearer",
        config: {},
      },
      actor_id: null,
    },
    ctx.db,
  );
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: created.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "stored-token" },
      actor_id: null,
    },
    ctx.db,
  );
  const { transitioned } = await markConnectorNeedsReauth(
    ctx.db,
    tenantId,
    created.id,
    "seeded for this test",
  );
  expect(transitioned).toBe(true);
  const fresh = await getConnector(tenantId, created.id, ctx.db);
  if (!fresh) throw new Error("connector vanished after seeding");
  expect(fresh.needs_reauth).toBe(true);
  return fresh;
}

async function readFlag(connector_id: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ needs_reauth: connectors.needs_reauth })
    .from(connectors)
    .where(eq(connectors.id, connector_id));
  if (!row) throw new Error("connector row missing");
  return row.needs_reauth;
}

test("a successful probe clears needs_reauth on the persisted connector", async () => {
  probeStatus = 200;
  const connector = await seedFlaggedConnector("clears-on-success");
  const result = await probeConnector({ db: ctx.db, tenant_id: tenantId, connector });
  expect(result.ok).toBe(true);
  expect(await readFlag(connector.id)).toBe(false);
});

test("a rejected probe leaves the flag standing — it is not proof the credential is live", async () => {
  probeStatus = 401;
  const connector = await seedFlaggedConnector("keeps-on-failure");
  const result = await probeConnector({ db: ctx.db, tenant_id: tenantId, connector });
  expect(result.ok).toBe(false);
  expect(await readFlag(connector.id)).toBe(true);
});

test("a draft probe with a supplied credential never clears the persisted flag", async () => {
  probeStatus = 200;
  const connector = await seedFlaggedConnector("keeps-on-override");
  const result = await probeConnector({
    db: ctx.db,
    tenant_id: tenantId,
    connector,
    credential_override: { mode: "bearer", token: "supplied-by-caller" },
  });
  expect(result.ok).toBe(true);
  // The success says the SUPPLIED material works. The stored row is untouched,
  // so a caller cannot launder an unrelated secret into a clean bill of health.
  expect(await readFlag(connector.id)).toBe(true);
});
