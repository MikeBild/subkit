import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { createConnector } from "../connectors/service.ts";
import { upsertCredential } from "../credentials/service.ts";
import { executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { logger } from "../logging/logger.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import type { RequestStep } from "../workflows/types.ts";
import { runRequestStep } from "./steps/request.ts";
import type { StepRunContext } from "./types.ts";

const OWN_SECRET = "fixture-own-client-secret-4d9a";
const OWN_CLIENT = "fixture-own-client-id-7c21";
const FOREIGN_TOKEN = "fixture-foreign-token-91be";
const TEST_NOW_MS = getTestNow();

interface Received {
  path: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let testDb: TestDb;
let tenantId: string;
let ownHost: MockServer;
let foreignHost: MockServer;
let ownConnectorId: string;
let ownReceived: Received[] = [];
let foreignReceived: Received[] = [];
const logged: unknown[] = [];

function recorder(into: () => Received[], echo: boolean) {
  return async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    into().push({ path: req.url, headers: req.headers, body });
    jsonResponse(res, 200, echo ? { echoed: body, ok: true } : { ok: true });
  };
}

const productCaller = (): ResolvedPrincipal => ({
  provider: "acme-idp",
  kind: "user",
  id: "11111111-2222-4333-8444-555555555555",
  tenant_id: tenantId,
  product_id: "acme",
  roles: ["member"],
  subject: "66666666-7777-4888-8999-000000000000",
});

async function seedConnector(slug: string, baseUrl: string, value: unknown, authType: string) {
  const created = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: slug,
        slug,
        driver: "http",
        environment: "dev",
        base_url: baseUrl,
        auth_type: authType,
        config: {},
      } as Parameters<typeof createConnector>[0]["input"],
      actor_id: null,
    },
    testDb.db,
  );
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: created.id,
      environment: "dev",
      mode: authType as "header",
      value: value as { mode: "header"; headers: Record<string, string> },
      actor_id: null,
    },
    testDb.db,
  );
  return created.id;
}

async function run(
  step: Omit<RequestStep, "kind" | "id" | "method"> & { method?: RequestStep["method"] },
  options: {
    principal?: ResolvedPrincipal | null;
    hold_writes?: boolean;
    under_authority?: boolean;
  } = {},
) {
  const [exec] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      source_kind: "step",
      status: "running",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning({ id: executions.id });
  if (!exec) throw new Error("execution fixture missing");
  const full = { id: "exchange", kind: "request", method: "POST", max_retries: 0, ...step };
  const requestStep = full as RequestStep;
  const [stepRow] = await testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: tenantId,
      execution_id: exec.id,
      step_key: requestStep.id,
      step_index: 0,
      kind: "request",
      status: "running",
      started_at: new Date(TEST_NOW_MS),
    })
    .returning({ id: executionSteps.id });
  if (!stepRow) throw new Error("step fixture missing");
  const ctx: StepRunContext = {
    db: testDb.db,
    tenant_id: tenantId,
    execution_id: exec.id,
    workflow_id: "00000000-0000-0000-0000-000000000000",
    workflow_version_id: "00000000-0000-0000-0000-000000000000",
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope: { $input: { code: "auth-code-1" } },
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "test",
    trace_id: null,
    principal: options.principal === undefined ? productCaller() : options.principal,
    execution_mode: "dev",
    step: requestStep,
    step_index: 0,
    step_row_id: stepRow.id,
    persist_workflow_refs: false,
    llm_budget: new RunLlmBudget(null),
    ...(options.hold_writes ? { hold_writes: true } : {}),
    ...(options.under_authority === false ? {} : { own_connector_credentials: true }),
  };
  return runRequestStep({ ctx, step: requestStep, scope: { $input: { code: "auth-code-1" } } });
}

async function storedText(): Promise<string> {
  const rows = await testDb.db.execute<{ dump: string }>(
    sql`SELECT coalesce(string_agg(t::text, ' '), '') AS dump FROM (
      SELECT a::text AS t FROM audit_log a WHERE a.tenant_id = ${tenantId}
      UNION ALL SELECT s::text FROM execution_steps s WHERE s.tenant_id = ${tenantId}
      UNION ALL SELECT e::text FROM executions e WHERE e.tenant_id = ${tenantId}
    ) rows`,
  );
  return rows.rows[0]?.dump ?? "";
}

const FORM_BODY =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  "client_id=${cred.own-idp.client_id}&client_secret=${cred.own-idp.client_secret}&code=${input.code}";

const capturedLevels = ["debug", "info", "warn", "error"] as const;
const originalLevels = new Map<string, unknown>();

beforeAll(async () => {
  testDb = await createTestDb("own-connector-credentials");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "own-connector-credentials", display_name: "Own connector credentials" })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  tenantId = tenant.id;
  ownHost = await createMockServer(recorder(() => ownReceived, true));
  foreignHost = await createMockServer(recorder(() => foreignReceived, false));
  ownConnectorId = await seedConnector(
    "own-idp",
    ownHost.baseUrl,
    { mode: "header", headers: { client_id: OWN_CLIENT, client_secret: OWN_SECRET } },
    "header",
  );
  await seedConnector(
    "foreign-idp",
    foreignHost.baseUrl,
    { mode: "bearer", token: FOREIGN_TOKEN },
    "bearer",
  );
  const mutable = logger as unknown as Record<string, unknown>;
  for (const level of capturedLevels) {
    const original = mutable[level] as (...args: unknown[]) => unknown;
    originalLevels.set(level, original);
    mutable[level] = (...args: unknown[]) => {
      logged.push(args);
      return original.apply(logger, args);
    };
  }
});

afterAll(async () => {
  const mutable = logger as unknown as Record<string, unknown>;
  for (const [level, original] of originalLevels) mutable[level] = original;
  await ownHost.close();
  await foreignHost.close();
  await testDb.cleanup();
});

beforeEach(() => {
  ownReceived = [];
  foreignReceived = [];
});

describe("credentials of the step's own connector", () => {
  test("resolve in body and headers for a caller without connector:read and reach only that host", async () => {
    const result = await run({
      connector_id: ownConnectorId,
      path: "/auth/token",
      side_effects: "write",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        "x-client-assertion": "${cred.own-idp.client_secret}",
      },
      body: FORM_BODY,
    });
    expect(result.status).toBe("succeeded");
    expect(foreignReceived).toHaveLength(0);
    expect(ownReceived).toHaveLength(1);
    expect(ownReceived[0]?.body).toBe(
      `client_id=${OWN_CLIENT}&client_secret=${OWN_SECRET}&code=auth-code-1`,
    );
    expect(ownReceived[0]?.headers["x-client-assertion"]).toBe(OWN_SECRET);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(OWN_SECRET);
    expect(serialized).not.toContain(OWN_CLIENT);
    expect(serialized).toContain("***redacted***");
    expect(await storedText()).not.toContain(OWN_SECRET);
    expect(JSON.stringify(logged)).not.toContain(OWN_SECRET);
  });

  test("without an execution authority the own credential needs connector:read", async () => {
    const result = await run(
      {
        connector_id: ownConnectorId,
        path: "/auth/token",
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        headers: { "x-probe": "${cred.own-idp.client_secret}" },
      },
      { under_authority: false },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("placeholder_unresolved");
    expect(JSON.stringify(result.error)).toContain("rbac_denied");
    expect(ownReceived).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(OWN_SECRET);
  });

  test("a held preparation shows no resolved credential", async () => {
    const result = await run(
      {
        connector_id: ownConnectorId,
        path: "/auth/revoke",
        side_effects: "write",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        body: { grant: "${cred.own-idp.client_secret}", token: "t-1" },
      },
      { hold_writes: true },
    );
    expect(ownReceived).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(OWN_SECRET);
    expect(await storedText()).not.toContain(OWN_SECRET);
  });

  test("another connector's credential is refused and nothing is sent", async () => {
    const result = await run({
      connector_id: ownConnectorId,
      path: "/auth/token",
      side_effects: "write",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      body: "client_secret=${cred.foreign-idp.token}",
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("placeholder_unresolved");
    expect(ownReceived).toHaveLength(0);
    expect(foreignReceived).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(FOREIGN_TOKEN);
  });

  test("the own credential is not sent to an address outside the connector's origin", async () => {
    const result = await run({
      connector_id: ownConnectorId,
      path: `${foreignHost.baseUrl}/collect`,
      side_effects: "write",
      body: FORM_BODY,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("credential_boundary_violation");
    expect(ownReceived).toHaveLength(0);
    expect(foreignReceived).toHaveLength(0);
  });

  test("a caller without a principal still resolves any connector's credential as before", async () => {
    const result = await run(
      {
        connector_id: ownConnectorId,
        path: "/auth/token",
        side_effects: "write",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        body: "assertion=${cred.foreign-idp.token}",
      },
      { principal: null },
    );
    expect(result.status).toBe("succeeded");
    expect(ownReceived[0]?.body).toBe(`assertion=${FOREIGN_TOKEN}`);
    expect(JSON.stringify(result.output)).toContain(FOREIGN_TOKEN);
  });
});
