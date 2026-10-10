import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  parseIntakeLiveArgs,
  runIntakeLiveSmoke,
} from "../../../../../scripts/verify-intake-live.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("intake-live-smoke");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("intake live smoke against the public local API", () => {
  test("collects, reviews, confirms, and finds one retained domain source", async () => {
    const args = parseIntakeLiveArgs(
      [
        "--engine-url",
        ctx.baseUrl,
        "--allow-writes",
        "--run-id",
        "intake-live-http",
        "--test-tenant-id",
        ctx.tenantId,
        "--json",
        "/tmp/intake-live-smoke.json",
      ],
      { SK_INTAKE_TEST_KEY: ctx.apiKey },
    );
    const report = await runIntakeLiveSmoke(args);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.skipped).toBe(0);
    expect(report.retained_resource_ids).toHaveLength(3);
    expect(report.checks.map((check) => check.id)).toEqual([
      "health.contract",
      "ready.contract",
      "openapi.intake_contract",
      "llms.intake_contract",
      "clipper.archive",
      "briefing.contract",
      "write.identity",
      "write.collect",
      "write.preconfirm_exclusion",
      "write.propose",
      "write.review_exact",
      "write.confirm",
      "write.confirm_idempotent",
      "write.single_admission",
      "write.provenance",
      "write.search",
      "write.briefing",
    ]);
    expect(report.cleanup).toMatchObject({ attempted: false, status: "not_attempted" });
  }, 60_000);
});
