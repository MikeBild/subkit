import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeJwt, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import {
  AuthorityDispatchError,
  executePlannedHttpRequest,
} from "../../connectors/drivers/http.ts";
import { getConnector } from "../../connectors/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors } from "../../db/schema/index.ts";
import { setTestNow } from "../../utils/clock.ts";
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
let mock: MockServer;
let connectorId: string;
let requestCount = 0;
let receivedTokens: string[] = [];
let privateKeyPem: string;
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
let testNow = 1_700_000_000_000;

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  expect(typeof value).toBe("string");
  expect(value).toStartWith("Bearer ");
  return (value as string).slice("Bearer ".length);
}

async function verifyBearer(token: string, currentDate: Date): Promise<void> {
  await jwtVerify(token, publicKey, {
    algorithms: ["ES256"],
    audience: "workflow-test",
    issuer: "issuer-test",
    currentDate,
  });
}

beforeAll(async () => {
  ctx = await createEngineCtx("signed-jwt-request");
  mock = await createMockServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    receivedTokens.push(bearer(req));
    if (requestCount === 1) {
      jsonResponse(res, 503, { retry: true });
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });

  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "signed-jwt-workflow",
      display_name: "Signed JWT workflow fixture",
      driver: "http",
      environment: "dev",
      auth_type: "signed_jwt",
      base_url: mock.baseUrl,
      config: {
        signed_jwt: {
          algorithm: "ES256",
          audience: "workflow-test",
          issuer: "issuer-test",
          key_id: "key-test",
          ttl_seconds: 300,
        },
      },
    })
    .returning();
  connectorId = connector!.id;
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKeyPem = await exportPKCS8(pair.privateKey);
  publicKey = pair.publicKey;
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connectorId,
      environment: "dev",
      mode: "signed_jwt",
      value: { mode: "signed_jwt", private_key: privateKeyPem },
      actor_id: null,
    },
    ctx.testDb.db,
  );
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

beforeEach(() => {
  requestCount = 0;
  receivedTokens = [];
  testNow = 1_700_000_000_000;
  setTestNow(() => testNow);
});

afterEach(() => {
  setTestNow(null);
});

async function signedConnector() {
  const connector = await getConnector(ctx.tenantId, connectorId, ctx.testDb.db);
  if (!connector) throw new Error("signed JWT fixture connector is missing");
  return connector;
}

describe("signed_jwt request-step transport", () => {
  test("signs each retry immediately before the outbound attempt", async () => {
    mock.setHandler((req, res) => {
      requestCount += 1;
      receivedTokens.push(bearer(req));
      if (requestCount === 1) {
        testNow += 301_000;
        jsonResponse(res, 503, { retry: true });
        return;
      }
      jsonResponse(res, 200, { ok: true });
    });
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "signed-jwt-retry",
      steps: [
        {
          kind: "request",
          id: "read",
          method: "GET",
          connector_id: connectorId,
          path: "/apps",
          max_retries: 1,
          retry_backoff_ms: 50,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(requestCount).toBe(2);
    expect(receivedTokens).toHaveLength(2);
    await verifyBearer(receivedTokens[0]!, new Date(1_700_000_000_000));
    await verifyBearer(receivedTokens[1]!, new Date(1_700_000_301_000));
    const first = decodeJwt(receivedTokens[0]!);
    const second = decodeJwt(receivedTokens[1]!);
    expect(first).toMatchObject({
      aud: "workflow-test",
      iss: "issuer-test",
      iat: 1_700_000_000,
      exp: 1_700_000_300,
    });
    expect(second).toMatchObject({
      aud: "workflow-test",
      iss: "issuer-test",
      iat: 1_700_000_301,
      exp: 1_700_000_601,
    });
  });

  test("does not expose its JWT to dispatch hooks and scrubs an echoed token", async () => {
    mock.setHandler((req, res) => {
      const token = bearer(req);
      res.setHeader("content-type", "application/json");
      res.setHeader("authorization", `Bearer ${token}`);
      res.end(JSON.stringify({ reflected: token }));
    });
    const seenByHook: Record<string, string>[] = [];
    const result = await executePlannedHttpRequest({
      exec: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      method: "GET",
      url: new URL(`${mock.baseUrl}/echo`),
      headers: { Accept: "application/json" },
      signal: new AbortController().signal,
      signed_jwt: {
        connector: await signedConnector(),
        credential: { mode: "signed_jwt", private_key: privateKeyPem },
      },
      before_dispatch: async (request) => {
        seenByHook.push(request.headers);
        return undefined;
      },
    });

    expect(seenByHook).toEqual([{ Accept: "application/json" }]);
    expect(JSON.stringify(result)).not.toContain("eyJ");
    expect(result.headers.authorization).toContain("[REDACTED]");
    expect(result.body).toEqual({ reflected: "[REDACTED]" });
  });

  test("signs every paginated transport request", async () => {
    mock.setHandler((req, res) => {
      requestCount += 1;
      receivedTokens.push(bearer(req));
      const offset = new URL(req.url ?? "/", mock.baseUrl).searchParams.get("offset");
      if (offset === "0") {
        testNow += 301_000;
        jsonResponse(res, 200, { items: [{ id: "first" }] });
        return;
      }
      jsonResponse(res, 200, { items: [] });
    });
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "signed-jwt-pagination",
      steps: [
        {
          kind: "request",
          id: "pages",
          method: "GET",
          connector_id: connectorId,
          path: "/apps",
          pagination: {
            strategy: "offset",
            offset_param: "offset",
            limit_param: "limit",
            page_size: 1,
            items_path: "items",
          },
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(requestCount).toBe(2);
    await verifyBearer(receivedTokens[0]!, new Date(1_700_000_000_000));
    await verifyBearer(receivedTokens[1]!, new Date(1_700_000_301_000));
    expect(decodeJwt(receivedTokens[0]!).iat).toBe(1_700_000_000);
    expect(decodeJwt(receivedTokens[1]!).iat).toBe(1_700_000_301);
  });

  test("refuses a redirect after sending a signed request", async () => {
    mock.setHandler((_, res) => {
      res.statusCode = 302;
      res.setHeader("location", "https://redirect.invalid/elsewhere");
      res.end();
    });
    await expect(
      executePlannedHttpRequest({
        exec: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        method: "GET",
        url: new URL(`${mock.baseUrl}/redirect`),
        headers: {},
        signal: new AbortController().signal,
        signed_jwt: {
          connector: await signedConnector(),
          credential: { mode: "signed_jwt", private_key: privateKeyPem },
        },
      }),
    ).rejects.toBeInstanceOf(AuthorityDispatchError);
  });
});
