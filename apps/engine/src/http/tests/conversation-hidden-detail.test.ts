import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("conv-hidden-detail");
});

afterAll(async () => {
  await srv.cleanup();
});

function call(method: string, path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

async function hiddenInDetail(id: string): Promise<unknown> {
  const res = await call("GET", `/v1/conversations/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { conversation: { hidden?: unknown } }).conversation.hidden;
}

describe("GET /v1/conversations/:id · hidden", () => {
  test("the detail says whether the viewer hid the conversation, so it can be shown again", async () => {
    const [row] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", owner_id: srv.userId })
      .returning({ id: conversations.id });
    if (!row) throw new Error("seed conversation failed");

    expect(await hiddenInDetail(row.id)).toBe(false);
    expect((await call("POST", `/v1/conversations/${row.id}/hide`)).status).toBe(200);
    expect(await hiddenInDetail(row.id)).toBe(true);
    expect((await call("POST", `/v1/conversations/${row.id}/unhide`)).status).toBe(200);
    expect(await hiddenInDetail(row.id)).toBe(false);
  });
});
