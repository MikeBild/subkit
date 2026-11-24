import { afterAll, beforeAll, expect, test } from "bun:test";
import type { IncomingHttpHeaders } from "node:http";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let server: MockServer;
const received: IncomingHttpHeaders[] = [];

async function sigv4Connector(slug: string, config: Record<string, unknown>): Promise<string> {
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: "aws_sigv4",
      environment: "dev",
      base_url: server.baseUrl,
      config,
    })
    .returning();
  if (!connector) throw new Error("connector fixture missing");
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connector.id,
      environment: "dev",
      mode: "aws_sigv4",
      value: { mode: "aws_sigv4", access_key_id: "TESTACCESS", secret_access_key: "TESTSECRET" },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  return connector.id;
}

async function runStep(slug: string, step: Record<string, unknown>) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: `SigV4 ${slug}`,
    slug,
    steps: [{ id: "call", kind: "request", method: "GET", ...step }],
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

beforeAll(async () => {
  ctx = await createEngineCtx("request-step-sigv4");
  server = await createMockServer((request, response) => {
    received.push(request.headers);
    jsonResponse(response, 200, { ok: true });
  });
});

afterAll(async () => {
  if (server) await server.close();
  if (ctx) await ctx.cleanup();
});

function expectSigned(headers: IncomingHttpHeaders | undefined) {
  const timestamp = headers?.["x-amz-date"];
  expect(timestamp).toMatch(/^\d{8}T\d{6}Z$/);
  const date = String(timestamp).slice(0, 8);
  expect(headers?.authorization).toStartWith(
    `AWS4-HMAC-SHA256 Credential=TESTACCESS/${date}/us-east-1/sqs/aws4_request`,
  );
}

test("a request step bound by connector_id signs an aws_sigv4 connector", async () => {
  const connectorId = await sigv4Connector("aws-queue", {
    aws_region: "us-east-1",
    aws_service: "sqs",
  });
  received.length = 0;
  const result = await runStep("sigv4-by-id", { connector_id: connectorId, path: "/" });
  expect(result.status).toBe("succeeded");
  expect(received).toHaveLength(1);
  expectSigned(received[0]);
});

test("an aws_sigv4 connector without aws_service fails setup instead of sending unsigned", async () => {
  const connectorId = await sigv4Connector("aws-unscoped", { aws_region: "us-east-1" });
  received.length = 0;
  const result = await runStep("sigv4-missing-service", { connector_id: connectorId, path: "/" });
  expect(result.status).toBe("failed");
  expect(received).toHaveLength(0);
});
