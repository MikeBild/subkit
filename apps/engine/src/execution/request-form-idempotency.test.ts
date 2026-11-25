import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getBuiltinTemplate } from "../connectors/templates.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { HttpRequestStepSchema, type RequestStep } from "../workflows/types.ts";
import { runRequestStep } from "./steps/request.ts";
import { createMockServer, jsonResponse, type MockServer } from "./tests/setup.ts";
import type { StepRunContext } from "./types.ts";

const TEST_NOW_MS = getTestNow();

type ObservedRequest = {
  body: string;
  content_type: string | null;
  idempotency_key: string | null;
};

let testDb: TestDb;
let tenantId: string;
let mock: MockServer;
const observed: ObservedRequest[] = [];

beforeAll(async () => {
  testDb = await createTestDb("request-form-idempotency");
  const tenant = await seedTenant(testDb.db, { slug: "form-idem", display_name: "Form Idem" });
  tenantId = tenant.id;
  mock = await createMockServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      observed.push({
        body: Buffer.concat(chunks).toString("utf8"),
        content_type: (req.headers["content-type"] as string | undefined) ?? null,
        idempotency_key: (req.headers["idempotency-key"] as string | undefined) ?? null,
      });
      jsonResponse(res, 200, { ok: true });
    });
  });
});

afterAll(async () => {
  await mock.close();
  await testDb.cleanup();
});

async function createExecutionRow(): Promise<{ execution_id: string; step_row_id: string }> {
  const [execution] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      source_kind: "step",
      status: "running",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning({ id: executions.id });
  if (!execution) throw new Error("execution insert failed");
  const [stepRow] = await testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: tenantId,
      execution_id: execution.id,
      step_key: "send",
      step_index: 0,
      kind: "request",
      status: "running",
      started_at: new Date(TEST_NOW_MS),
    })
    .returning({ id: executionSteps.id });
  if (!stepRow) throw new Error("step row insert failed");
  return { execution_id: execution.id, step_row_id: stepRow.id };
}

async function send(rawStep: Record<string, unknown>, input: Record<string, unknown>) {
  observed.length = 0;
  const step = HttpRequestStepSchema.parse({
    id: "send",
    kind: "request",
    method: "POST",
    url: `${mock.baseUrl}/submit`,
    max_retries: 0,
    ...rawStep,
  }) as RequestStep;
  const ids = await createExecutionRow();
  const ctx: StepRunContext = {
    db: testDb.db,
    tenant_id: tenantId,
    execution_id: ids.execution_id,
    workflow_id: "",
    workflow_version_id: "",
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope: { $input: input },
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "test",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step,
    step_index: 0,
    step_row_id: ids.step_row_id,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
  const result = await runRequestStep({ ctx, step, scope: { $input: input } });
  return { result, ids };
}

describe("request step form body", () => {
  test("form fields are resolved and sent url-encoded", async () => {
    const message = "Rappel café – 15:00 + 5 min & merci.";
    const { result } = await send(
      { form: { To: "${input.to}", Body: "${input.message}", Count: 3, Plain: "fixed" } },
      { to: "+12025550111", message },
    );
    expect(result.status).toBe("succeeded");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.content_type).toContain("application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(observed[0]?.body ?? "");
    expect([...parsed.keys()]).toEqual(["To", "Body", "Count", "Plain"]);
    expect(parsed.get("To")).toBe("+12025550111");
    expect(parsed.get("Body")).toBe(message);
    expect(parsed.get("Count")).toBe("3");
  });

  test("a form field resolving to null is omitted", async () => {
    const { result } = await send(
      { form: { Action: "List", Namespace: "${input.namespace}" } },
      { namespace: null },
    );
    expect(result.status).toBe("succeeded");
    expect(observed[0]?.body).toBe("Action=List");
  });

  test("an explicit Content-Type is kept", async () => {
    const { result } = await send(
      {
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        form: { a: "1" },
      },
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(observed[0]?.content_type).toBe("application/x-www-form-urlencoded; charset=utf-8");
    expect(observed[0]?.body).toBe("a=1");
  });

  test("form together with body is rejected", () => {
    const parsed = HttpRequestStepSchema.safeParse({
      id: "send",
      kind: "request",
      method: "POST",
      url: "https://example.test/submit",
      form: { a: "1" },
      body: { a: "1" },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("form");
  });
});

describe("request step idempotency_key", () => {
  test("the resolved idempotency_key is sent as the Idempotency-Key header", async () => {
    const { result } = await send(
      { idempotency_key: "order-${input.order_number}", body: { a: 1 } },
      { order_number: "1042" },
    );
    expect(result.status).toBe("succeeded");
    expect(observed[0]?.idempotency_key).toBe("order-1042");
  });

  test("an explicit Idempotency-Key header wins over idempotency_key", async () => {
    const { result } = await send(
      {
        headers: { "idempotency-key": "explicit-header-value" },
        idempotency_key: "order-${input.order_number}",
        body: { a: 1 },
      },
      { order_number: "1042" },
    );
    expect(result.status).toBe("succeeded");
    expect(observed[0]?.idempotency_key).toBe("explicit-header-value");
  });

  test("a bounded step checks the derived Idempotency-Key against its reviewed rule", async () => {
    const boundedStep = {
      form: { amount: "${input.amount}" },
      idempotency_key: "${input.idempotency_key}",
      boundary: {
        variables: { "input.idempotency_key": { class: "identifier" } },
        max_body_bytes: 1024,
        max_calls: 1,
      },
    };
    const allowed = await send(boundedStep, { amount: "12", idempotency_key: "order-1042" });
    expect(allowed.result.status).toBe("succeeded");
    expect(observed[0]?.idempotency_key).toBe("order-1042");
    expect(observed[0]?.body).toBe("amount=12");
    const refused = await send(boundedStep, { amount: "12", idempotency_key: "order 1042!" });
    expect(refused.result.status).toBe("failed");
    expect(refused.result.error?.code).toBe("request_outside_declared_boundary");
    expect(observed).toHaveLength(0);
  });

  test("without idempotency_key the generated per-step key is kept", async () => {
    const { result, ids } = await send({ body: { a: 1 } }, {});
    expect(result.status).toBe("succeeded");
    expect(observed[0]?.idempotency_key).toBe(`${ids.execution_id}:${ids.step_row_id}:0`);
  });
});

const formTemplates = [
  "aws-cloudwatch-alarms",
  "aws-cloudwatch-metrics",
  "aws-sts",
  "oauth2-generic",
];

const recipeFormSteps = formTemplates.flatMap((templateSlug) =>
  (getBuiltinTemplate(templateSlug)?.recipes ?? []).flatMap((recipe) =>
    ((recipe.workflow as { steps?: Array<Record<string, unknown>> } | undefined)?.steps ?? [])
      .filter((raw) => raw.kind === "request" && raw.form !== undefined)
      .map((raw) => ({ label: `${templateSlug}/${recipe.slug}`, raw })),
  ),
);

const sampleInput = (form: Record<string, unknown>) =>
  Object.fromEntries(
    [...JSON.stringify(form).matchAll(/\$\{input\.([A-Za-z_]+)(\[0\])?\}/g)].map(
      ([, name, indexed]) => [name, indexed ? ["sample-alarm"] : `sample-${name}`],
    ),
  );

describe("form recipes send their fields", () => {
  for (const { label, raw } of recipeFormSteps)
    test(`${label} sends a non-empty url-encoded body`, async () => {
      const { connector_id: _connectorId, path: _path, ...rest } = raw;
      const form = raw.form as Record<string, unknown>;
      const { result } = await send({ ...rest, url: `${mock.baseUrl}/recipe` }, sampleInput(form));
      expect(result.status).toBe("succeeded");
      expect(observed[0]?.body.length).toBeGreaterThan(0);
      expect([...new URLSearchParams(observed[0]?.body ?? "").keys()]).toEqual(Object.keys(form));
    });
});
