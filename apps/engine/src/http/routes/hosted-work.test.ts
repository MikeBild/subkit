import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { hostedWorkAdmissions, tenants } from "../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../tests/setup.ts";

let ctx: HttpTestServer;
let tenantId: string;
let headers: Record<string, string>;
const uuid = createDeterministicUuidFactory(0x4eac713);
const evidence =
  "A human checked the external shutdown acknowledgement and verified that all child producers of the exact former process exited before reviewing this admission for release.";

beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-work-review");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "work-review-target", display_name: "Target" })
    .returning();
  if (!tenant) throw new Error("missing tenant");
  tenantId = tenant.id;
  headers = await browserSessionHeaders(ctx, ctx.userId);
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

function path() {
  return `${ctx.baseUrl}/v1/settings/hosted-work/${tenantId}`;
}
function post(body: unknown, requestHeaders = headers) {
  return fetch(path(), { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
}
async function work(owner = uuid()) {
  const [row] = await ctx.db
    .insert(hostedWorkAdmissions)
    .values({ tenant_id: tenantId, kind: "chat", state: "active", owner_boot_id: owner })
    .returning();
  if (!row) throw new Error("missing work");
  return row;
}
function review(row: Awaited<ReturnType<typeof work>>) {
  return {
    admission_id: row.id,
    owner_boot_id: row.owner_boot_id,
    reviewed_owner_stop_evidence: evidence,
    all_work_from_owner_stopped: true,
  };
}

test("actual HTTP authentication and CSRF protect the operator review decision", async () => {
  const row = await work();
  expect((await fetch(path())).status).toBe(401);
  const bearer = { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
  expect((await fetch(path(), { headers: bearer })).status).toBe(403);
  expect((await post(review(row), bearer)).status).toBe(403);
  const withoutCsrf = { ...headers };
  delete withoutCsrf["x-subkit-csrf"];
  const missing = await post(review(row), withoutCsrf);
  expect(missing.status).toBe(403);
  expect(await missing.json()).toMatchObject({ code: "csrf_rejected" });
  expect((await post(review(row), { ...headers, "sec-fetch-site": "cross-site" })).status).toBe(
    403,
  );
  const released = await post(review(row));
  expect(released.status).toBe(200);
  const body = (await released.json()) as { evidence_sha256: string };
  expect(body.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(body)).not.toContain(evidence);
  expect((await post(review(row))).status).toBe(409);
});

test("current-process work remains active after a fully authenticated release attempt", async () => {
  const row = await work(tenantWorkSnapshot(tenantId).boot_id);
  expect((await post(review(row))).status).toBe(409);
  const [saved] = await ctx.db
    .select()
    .from(hostedWorkAdmissions)
    .where(and(eq(hostedWorkAdmissions.tenant_id, tenantId), eq(hostedWorkAdmissions.id, row.id)));
  expect(saved?.state).toBe("active");
});

test("large unresolved lists are bounded and exclude a neighboring tenant", async () => {
  await ctx.db.insert(hostedWorkAdmissions).values(
    Array.from({ length: 101 }, () => ({
      tenant_id: tenantId,
      kind: "execution" as const,
      state: "active" as const,
      owner_boot_id: uuid(),
    })),
  );
  const [neighbor] = await ctx.db
    .insert(hostedWorkAdmissions)
    .values({ tenant_id: ctx.tenantId, kind: "chat", state: "active", owner_boot_id: uuid() })
    .returning();
  if (!neighbor) throw new Error("missing neighbor");
  const response = await fetch(path(), { headers });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: { admission_id: string; tenant_id: string }[];
    has_more: boolean;
  };
  expect(body.has_more).toBe(true);
  expect(body.items).toHaveLength(100);
  expect(body.items.every((item) => item.tenant_id === tenantId)).toBe(true);
  expect(body.items.some((item) => item.admission_id === neighbor.id)).toBe(false);
});
