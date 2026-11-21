import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

interface AuditRow {
  action: string;
  result: string;
  actor_type: string;
  actor_id: string | null;
  resource_type: string;
  resource_id: string | null;
  metadata?: { api_key_id?: string };
}

let ctx: JourneyCtx;
let echo: Server;
let workflowId = "";
let keyId = "";
let narrowKey = "";
let executionId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("core-api-key-scopes");
  echo = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ stock: 12 }));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  const created = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Stock level",
      slug: "stock-level",
      steps: [{ kind: "request", id: "stock", method: "GET", url: `${base}/stock` }],
    }),
  });
  workflowId = ((await created.json()) as { id: string }).id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => echo.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

function asNarrowKey(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${narrowKey}`, "content-type": "application/json" },
  });
}

async function auditRows(): Promise<AuditRow[]> {
  const res = await journeyFetch(ctx, "/v1/audit-log?limit=200");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: AuditRow[] }).items;
}

describe("an API key with narrow scopes runs what it may and is refused the rest", () => {
  test("an admin issues a key that may only run workflows and read executions", async () => {
    const res = await journeyFetch(ctx, "/v1/identity/api-keys", {
      method: "POST",
      body: JSON.stringify({
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        name: "stock-reader",
        scopes: ["workflow:run", "execution:read"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; scopes: string[]; plaintext_key: string };
    expect(body.scopes).toEqual(["workflow:run", "execution:read"]);
    keyId = body.id;
    narrowKey = body.plaintext_key;
    expect(narrowKey.startsWith("wf_live_")).toBe(true);
  });

  test("the key runs the workflow and reads its result", async () => {
    const run = await asNarrowKey("/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
    });
    expect(run.status).toBe(200);
    const ran = (await run.json()) as { execution_id: string; status: string; output: unknown };
    expect(ran.status).toBe("succeeded");
    expect(ran.output).toEqual({ stock: 12 });
    executionId = ran.execution_id;
    const read = await asNarrowKey(`/v1/executions/${executionId}`);
    expect(read.status).toBe(200);
    const execution = (await read.json()) as {
      status: string;
      workflow_id: string;
      caller: { kind: string; principal_id: string; verified_by: string; channel: string };
    };
    expect(execution.status).toBe("succeeded");
    expect(execution.workflow_id).toBe(workflowId);
    expect(execution.caller).toMatchObject({
      kind: "system_account",
      principal_id: ctx.systemAccountId,
      verified_by: "api_key",
      channel: "api",
    });
  });

  test("outside its scopes the key gets 403 naming the missing permission, and nothing is created", async () => {
    const connector = await asNarrowKey("/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Warehouse",
        slug: "warehouse",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "http://127.0.0.1:9",
      }),
    });
    expect(connector.status).toBe(403);
    const refusal = (await connector.json()) as { details: { required: string; cause: string } };
    expect(refusal.details).toEqual({
      required: "connector:write",
      cause: "credential_ceiling:scope_not_granted",
    });
    const users = await asNarrowKey("/v1/identity/users");
    expect(users.status).toBe(403);
    expect(((await users.json()) as { details: { required: string } }).details.required).toBe(
      "identity:read",
    );
    const list = await journeyFetch(ctx, "/v1/connectors");
    const items = ((await list.json()) as { items: Array<{ slug: string }> }).items;
    expect(items.map((c) => c.slug)).not.toContain("warehouse");
  });

  test("the audit shows the issue, the run under the key and both refusals", async () => {
    const rows = await auditRows();
    const issued = rows.find((r) => r.action === "api_key.issued" && r.resource_id === keyId);
    expect(issued).toMatchObject({ result: "success", actor_type: "user", actor_id: ctx.userId });
    const byKey = rows.filter((r) => r.metadata?.api_key_id === keyId);
    const completed = byKey.find(
      (r) => r.action === "execution.completed" && r.resource_id === executionId,
    );
    expect(completed).toMatchObject({
      result: "success",
      actor_type: "system_account",
      actor_id: ctx.systemAccountId,
    });
    const denied = byKey.filter((r) => r.action === "policy.denied");
    expect(denied).toHaveLength(2);
    expect(denied.every((r) => r.result === "denied")).toBe(true);
  });
});
