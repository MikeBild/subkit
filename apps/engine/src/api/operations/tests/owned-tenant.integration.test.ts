import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";

const RESTORE = "/v1/identity/owned-tenant/restore";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_owned_tenant_restore");
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 60_000);

async function restore(headers: Record<string, string>) {
  const res = await fetch(`${ctx.baseUrl}${RESTORE}`, { method: "POST", headers });
  const body = (await res.json()) as { code: string; message: string };
  return { status: res.status, code: body.code, message: body.message };
}

describe("owned tenant restore declares the recovery CSRF header", () => {
  test("the contract lists x-subkit-recovery-csrf as a required header parameter", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    const doc = (await res.json()) as {
      paths: Record<string, { post: { parameters?: Record<string, unknown>[] } }>;
    };
    const parameters = doc.paths[RESTORE]?.post.parameters ?? [];
    expect(parameters).toEqual([
      expect.objectContaining({
        in: "header",
        name: "x-subkit-recovery-csrf",
        required: true,
        schema: { type: "string" },
      }),
    ]);
  });

  test("a missing header is still refused by the recovery check, not by request validation", async () => {
    expect(await restore({})).toEqual({
      status: 403,
      code: "forbidden",
      message: "recovery_unavailable",
    });
  });

  test("a header without a recovery proof is refused the same way", async () => {
    expect(await restore({ "x-subkit-recovery-csrf": "not-a-token" })).toEqual({
      status: 403,
      code: "forbidden",
      message: "recovery_unavailable",
    });
  });
});
