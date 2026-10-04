import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EngineClient } from "../../../../sk/src/engine-client.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;
let client: EngineClient;
let mock: Server;
let mockBase = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("cli");
  client = new EngineClient({ engine_url: ctx.baseUrl, api_key: ctx.apiKey });
  mock = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").startsWith("/openapi.json")) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "CLI Mock", version: "1.0" },
          paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
        }),
      );
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, from: "cli-mock" }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: CLI full onboarding", () => {
  test("AC1: health and readiness report the family contract", async () => {
    const [health, ready] = await Promise.all([client.health(), client.ready()]);
    expect(health.status).toBe("ok");
    expect(ready.status).toBe("ready");
    expect(ready.checks.database).toBe("pass");
  });

  test("AC2: connectors create + docs ingest via the CLI client", async () => {
    const connector = await client.createConnector({
      name: "CLI Connector",
      slug: "cli-connector",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mockBase,
    });
    expect(connector.id).toBeTruthy();

    const ingest = await client.ingestConnectorDocs(connector.id as string, {
      source_type: "openapi",
      url: `${mockBase}/openapi.json`,
    });
    const ingestBody = ingest as { ingested_count: number };
    expect(ingestBody.ingested_count).toBeGreaterThanOrEqual(1);

    const list = await client.listConnectors();
    expect(list.items.some((c) => c.id === connector.id)).toBe(true);
  });

  test("AC3: workflows create + run via the CLI client returns succeeded", async () => {
    const wf = await client.createWorkflow({
      name: "cli probe",
      slug: "cli-probe",
      steps: [
        {
          kind: "request",
          id: "ping",
          method: "GET",
          url: `${mockBase}/ping`,
        },
      ],
    });
    expect(wf.id).toBeTruthy();
    const run = await client.runExecution({
      source: "saved",
      workflow_id: wf.id as string,
      input: {},
    });
    expect(run.status).toBe("succeeded");
  });
});
