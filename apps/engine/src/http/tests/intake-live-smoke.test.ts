import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  parseIntakeLiveArgs,
  runIntakeLiveSmoke,
} from "../../../../../scripts/verify-intake-live.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("intake-live-smoke");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

function smokeArgs(extra: string[] = []) {
  return parseIntakeLiveArgs(
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
      ...extra,
    ],
    { SK_INTAKE_TEST_KEY: ctx.apiKey },
  );
}

const READ_ONLY_CHECKS = [
  "health.contract",
  "ready.contract",
  "openapi.intake_contract",
  "llms.intake_contract",
  "clipper.archive",
  "briefing.contract",
  "write.identity",
];

describe("intake live smoke against the public local API", () => {
  test("hands the proposal to a person, then finds one confirmed domain source", async () => {
    const proposed = await runIntakeLiveSmoke(smokeArgs());
    expect(proposed.summary).toMatchObject({ failed: 0, skipped: 1 });
    expect(proposed.checks.map((check) => check.id)).toEqual([
      ...READ_ONLY_CHECKS,
      "write.collect",
      "write.preconfirm_exclusion",
      "write.propose",
      "write.review_exact",
      "write.confirm_refused_for_key",
      "write.after_confirm",
    ]);
    const proposalId = proposed.handoff?.proposal_id ?? "";
    expect(proposed.handoff?.review_url).toBe(
      `${ctx.baseUrl}/cockpit/intake?proposal=${proposalId}`,
    );
    expect(proposed.retained_resource_ids).toHaveLength(2);

    const draft = (await (
      await fetch(`${ctx.baseUrl}/v1/intake/proposals/${proposalId}`, {
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
    ).json()) as { current_revision: number; revision: { digest: string } };
    const confirmation = await fetch(`${ctx.baseUrl}/v1/intake/proposals/${proposalId}/confirm`, {
      method: "POST",
      headers: await browserSessionHeaders(ctx, ctx.userId),
      body: JSON.stringify({
        expected_revision: draft.current_revision,
        digest: draft.revision.digest,
      }),
    });
    expect(confirmation.status).toBe(200);

    const admitted = await runIntakeLiveSmoke(
      smokeArgs(["--after-confirm", "--proposal-id", proposalId]),
    );
    expect(admitted.summary).toMatchObject({ failed: 0, skipped: 0 });
    expect(admitted.checks.map((check) => check.id)).toEqual([
      ...READ_ONLY_CHECKS,
      "write.confirmed",
      "write.single_admission",
      "write.provenance",
      "write.search",
      "write.briefing",
    ]);
    expect(admitted.retained_resource_ids).toHaveLength(3);
    expect(admitted.cleanup).toMatchObject({ attempted: false, status: "not_attempted" });
  }, 90_000);
});
