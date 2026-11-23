import { afterAll, beforeAll, expect, test } from "bun:test";
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
let connectorId: string;
let requests = 0;
const owner = "00000000-0000-4000-8000-000000000051";
const other = "00000000-0000-4000-8000-000000000052";

beforeAll(async () => {
  ctx = await createEngineCtx("caller-storage-dispatch");
  server = await createMockServer((_request, response) => {
    requests += 1;
    jsonResponse(response, 200, { owner: other });
  });
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "caller-store",
      display_name: "Caller Store",
      driver: "s3",
      auth_type: "aws_sigv4",
      environment: "dev",
      config: {
        endpoint: server.baseUrl,
        region: "us-east-1",
        bucket: "private-bucket",
        force_path_style: true,
      },
    })
    .returning();
  if (!connector) throw new Error("connector fixture missing");
  connectorId = connector.id;
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connectorId,
      environment: "dev",
      mode: "aws_sigv4",
      value: { mode: "aws_sigv4", access_key_id: "TESTACCESS", secret_access_key: "TESTSECRET" },
      actor_id: null,
    },
    ctx.testDb.db,
  );
});

afterAll(async () => {
  if (server) await server.close();
  if (ctx) await ctx.cleanup();
});

test("an unsupported S3 range cannot disable principal-bound ownership before dispatch", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Principal storage range boundary",
    slug: "principal-storage-range-boundary",
    product_id: "harmoniqs",
    steps: [
      {
        id: "read",
        kind: "request",
        protocol: "s3",
        connector_id: connectorId,
        method: "GET",
        s3: {
          key: `products/harmoniqs/user/${other}/song.json`,
          range: "bytes=0-100",
          scope: { key_prefix: "products/harmoniqs/", principal_bound: true, max_bytes: 256 },
        },
      },
    ],
  });
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
    options: {
      hold_writes: true,
      principal: {
        provider: "test",
        kind: "user",
        id: owner,
        tenant_id: ctx.tenantId,
        product_id: "harmoniqs",
        roles: ["admin"],
      },
    },
  });
  expect(result.status).toBe("failed");
  expect(requests).toBe(0);
});
