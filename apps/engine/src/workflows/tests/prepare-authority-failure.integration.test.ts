import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflowVersions } from "../../db/schema/index.ts";
import { reportAuthorityFixtures } from "../../execution/tests/report-authority-fixtures.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";

let ctx: EngineTestCtx;

const { fixture } = reportAuthorityFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createEngineCtx("prepare-authority-failure");
});

afterAll(async () => {
  await ctx.cleanup();
});

function refusal(error: unknown) {
  return error as { code?: string; message?: string; details?: Record<string, unknown> };
}

test("a failed preparation names the step that failed and why", async () => {
  const f = await fixture(true);
  const remote = Object.assign(
    async () => Response.json({ error: "metrics backend down" }, { status: 503 }),
    { preconnect: () => {} },
  ) as typeof fetch;
  const failed = await withSelfHostedDriverFetchForTests(remote, () =>
    f.automaticPrepare().then(
      () => null,
      (error: unknown) => error,
    ),
  );
  const { code, message, details } = refusal(failed);
  expect(code).toBe("authority_preparation_failed");
  expect(message).toContain("step read");
  expect(details).toMatchObject({ step_id: "read" });
  expect(typeof details?.execution_id).toBe("string");
  expect(typeof details?.step_code).toBe("string");
  expect(typeof details?.reason).toBe("string");
});

test("a preparation sample that misses the input contract names the field", async () => {
  const f = await fixture();
  const db = ctx.testDb.db;
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, f.wf.version_id));
  await db
    .update(workflowVersions)
    .set({
      dag: {
        ...(version?.dag as Record<string, unknown>),
        input_schema: {
          type: "object",
          required: ["raw", "since"],
          properties: { raw: { type: "string" }, since: { type: "string" } },
        },
      },
    })
    .where(eq(workflowVersions.id, f.wf.version_id));
  const failed = await f.automaticPrepare().then(
    () => null,
    (error: unknown) => error,
  );
  const { code, message, details } = refusal(failed);
  expect(code).toBe("input_schema_violation");
  expect(message).toContain("$input/since");
  expect(details).toMatchObject({
    issues: [{ path: "$input/since", message: "must have required property 'since'" }],
  });
  expect(typeof details?.execution_id).toBe("string");
});
