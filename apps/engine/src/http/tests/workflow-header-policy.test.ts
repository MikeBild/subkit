import { afterAll, beforeAll, expect, test } from "bun:test";
import { createConnector } from "../../connectors/index.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let connectorId: string;
beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_header_policy");
  const connector = await createConnector(
    {
      tenant_id: ctx.tenantId,
      actor_id: null,
      input: {
        name: "protected-budget",
        driver: "http",
        environment: "dev",
        base_url: "https://budget.example.test",
        auth_type: "header",
        config: {},
      },
    },
    ctx.db,
  );
  connectorId = connector.id;
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connector.id,
      environment: "dev",
      mode: "header",
      value: { mode: "header", headers: { "x-subkit-token": "fixture-budget-secret" } },
      actor_id: null,
    },
    ctx.db,
  );
}, 120_000);
afterAll(async () => {
  await ctx.cleanup();
});
function definition(headers: Record<string, string>, connector_id = connectorId) {
  return {
    name: "public-forwarding",
    steps: [{ id: "budget", kind: "request", method: "GET", path: "/rpc", connector_id, headers }],
  };
}
async function post(path: string, body: unknown) {
  return fetch(`${ctx.baseUrl}/v1/workflows${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("public validation and creation resolve saved custom credentials before permitting Authorization", async () => {
  const def = definition({ Authorization: "fixture-dynamic-jwt" });
  const validated = await post("/validate", def);
  expect(validated.status).toBe(200);
  expect(await validated.json()).toEqual({ ok: true });
  expect((await post("", def)).status).toBe(201);
});
test("public callers cannot override protected header names or supply their own forwarding allowlist", async () => {
  const denied = await post("/validate", definition({ "X-Subkit-Token": "override" }));
  expect(denied.status).toBe(200);
  expect(((await denied.json()) as { ok: boolean }).ok).toBe(false);
  const forged = await post("/validate", {
    ...definition({ Authorization: "override" }, "00000000-0000-4000-8000-000000000001"),
    noneAuthConnectorIds: ["00000000-0000-4000-8000-000000000001"],
  });
  expect(forged.status).toBe(200);
  expect(((await forged.json()) as { ok: boolean }).ok).toBe(false);
});
test("malformed connector identifiers are validation failures instead of database errors", async () => {
  const response = await post("/validate", definition({ Authorization: "fixture" }, "not-a-uuid"));
  expect(response.status).toBe(200);
  expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
});
