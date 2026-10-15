import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import type { PgBoss } from "pg-boss";
import { flushOidcBearerKeys } from "../../auth/providers/oidc-bearer.ts";
import { loadConfig } from "../../config/loader.ts";
import { workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createBoss, disposeBoss } from "../../queue/boss.ts";
import { registerExecutionRunHandler } from "../../queue/handlers/execution-run.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import {
  addUnpublishedKey,
  BEARER_NOW_SECONDS,
  startTestBearerIssuer,
  type TestBearerIssuer,
  unsignedToken,
} from "../../test-helpers/oidc-bearer-issuer.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let issuer: TestBearerIssuer;
let boss: PgBoss;
let app: ReturnType<typeof createApp>;
let workflowId: string;
const nextUuid = createDeterministicUuidFactory(0xa57c);

function token(sub: string, options: Parameters<TestBearerIssuer["mint"]>[1] = {}) {
  return issuer.mint(
    { sub },
    { issuedAt: BEARER_NOW_SECONDS, expiresIn: 10 * 365 * 24 * 3600, ...options },
  );
}

function call(path: string, bearer: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("product-bearer-async");
  issuer = await startTestBearerIssuer();
  const dir = mkdtempSync(join(tmpdir(), "sk-product-async-"));
  const created = await createWorkflowRow(ctx, {
    name: "async brain round",
    product_id: "tekit",
    required_caller_kind: "user",
    execution_privacy: "sensitive",
    steps: [
      {
        id: "round",
        kind: "transform",
        expression:
          "return { status: 'completed', output: [{ type: 'message', id: 'msg_1' }], model_usage: { input_tokens: 1 } };",
      },
    ],
    execution_guards: {
      caller_daily_limit: {
        bucket: "brain",
        limit: 50,
        tz: "Europe/Berlin",
        unit: "turn_id",
        round: "round",
        billable_steps: ["round"],
        commit_when: "$count(output[type = 'function_call']) = 0",
      },
    },
  });
  workflowId = created.workflow_id;
  const file = join(dir, "subkit.config.json");
  await writeFile(
    file,
    JSON.stringify({
      auth: {
        providers: [
          { protocol: "api_key", id: "api-key", label: "SubKit API key" },
          issuer.provider({ tenant_slug: "t-product-bearer-async" }),
        ],
        enable_signup: false,
      },
      products: {
        tekit: {
          execution_environment: "prod",
          assistant_workflow_id: workflowId,
          budget_bucket: "brain",
        },
      },
    }),
  );
  await loadConfig({
    env: { DATABASE_URL: ctx.testDb.url, NODE_ENV: "test" },
    configPathOverride: file,
  });
  flushOidcBearerKeys();
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: created.workflow_id,
      workflow_version_id: created.version_id,
      execution_environment: "prod",
    },
    ctx.db,
  );
  await ctx.db.insert(workflowExecutionAuthorities).values({
    tenant_id: ctx.tenantId,
    workflow_id: created.workflow_id,
    workflow_version_id: created.version_id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: { targets: [] },
    execution_environment: "prod",
    valid_from: new Date(Date.now() - 60_000),
    created_by: ctx.userId,
  });
  boss = await createBoss({ connectionString: ctx.testDb.url });
  app = createApp({ db: ctx.db, boss, registry: buildDefaultRegistry(ctx.db) });
  await registerExecutionRunHandler({ boss, db: ctx.db });
}, 60_000);

afterAll(async () => {
  if (boss) await disposeBoss(boss);
  await issuer?.stop();
  if (ctx) await ctx.cleanup();
}, 60_000);

describe("a BRAIN turn through the queue", () => {
  test("admission, queued run, polling and result all work with only the bearer token", async () => {
    const bearer = await token(nextUuid());
    const accepted = await call("/v1/executions", bearer, {
      method: "POST",
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        hold_writes: false,
        async: true,
        idempotency_key: "turn-a:1:1",
        input: { turn_id: "turn-a", round: 1 },
      }),
    });
    expect(accepted.status).toBe(202);
    const { execution_id } = (await accepted.json()) as { execution_id: string };
    const polled = await waitFor(
      async () => {
        const res = await call(`/v1/executions/${execution_id}`, bearer);
        const body = (await res.json()) as { status: string; execution_id: string };
        return ["queued", "running"].includes(body.status) ? null : body;
      },
      { tries: 150, sleepMs: 200, label: "queued bearer turn" },
    );
    expect(polled).toMatchObject({ execution_id, status: "succeeded", error: null });
    const result = await call(`/v1/executions/${execution_id}/result`, bearer);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      result: {
        status: "completed",
        output: [{ type: "message", id: "msg_1" }],
        model_usage: { input_tokens: 1 },
        usage: { usedToday: 1, dailyLimit: 50 },
      },
    });
    const budget = await call("/v1/budget", bearer);
    expect(await budget.json()).toMatchObject({ usedToday: 1, dailyLimit: 50 });
  });
});

describe("tokens that never authenticate", () => {
  const bearerRefusal = {
    code: "unauthorized",
    error: "unauthorized",
    message: "invalid bearer token",
  };

  test("an unknown key id, an HS256 token and an unsigned token answer the bearer 401", async () => {
    const sub = nextUuid();
    const unknownKid = await token(sub, { kid: "ghost", key: await addUnpublishedKey() });
    const hs256 = await new SignJWT({ sub, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer.issuer)
      .setAudience("authenticated")
      .setIssuedAt(BEARER_NOW_SECONDS)
      .setExpirationTime(BEARER_NOW_SECONDS + 600)
      .sign(new TextEncoder().encode("shared-secret-shared-secret-32by"));
    const none = unsignedToken({
      iss: issuer.issuer,
      aud: "authenticated",
      sub,
      role: "authenticated",
      iat: BEARER_NOW_SECONDS,
      exp: BEARER_NOW_SECONDS + 600,
    });
    for (const bad of [unknownKid, hs256, none]) {
      const res = await call("/v1/executions", bad);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(bearerRefusal);
    }
  });

  test("a token of a foreign issuer is not claimed and answers the generic 401", async () => {
    const foreign = await token(nextUuid(), { issuer: "https://other.example.test/auth/v1" });
    const res = await call("/v1/executions", foreign);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
  });
});
