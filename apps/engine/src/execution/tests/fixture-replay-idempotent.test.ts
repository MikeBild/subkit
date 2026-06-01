// Regression: fixture replay must not deepen the scope envelope.
//
// SUBKIT_BUGS.md Bug 2 — repeated dry-runs on the same draft made the engine
// ask for `$scope.<step>.data.data.slug`, adding a `.data` layer every rerun.
//
// Root cause: the dry-run cache rebuilds a step fixture as
// `{ data: <step_summary.output_preview> }`. The LIVE path records
// `output_preview` as the RAW step output, but the fixture-REPLAY path used to
// record the already-enveloped `{ data, … }`. So each rerun wrapped the body
// one level deeper. The fix records the unwrapped fixture `.data` as
// `output_preview`, keeping the replay path's summary shape identical to the
// live path — fixture round-trips are now idempotent.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("fixture_replay_idempotent");
});

afterAll(async () => {
  await ctx.cleanup();
});

const DRAFT = {
  name: "render-essay",
  steps: [
    {
      kind: "transform" as const,
      id: "render",
      expression: '{ "markdown": "# Title", "slug": "title", "title": "Title" }',
    },
  ],
};

describe("fixture replay idempotency (SUBKIT_BUGS Bug 2)", () => {
  test("live run records the RAW transform output as output_preview", async () => {
    const live = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: DRAFT },
      input: null,
    });
    expect(live.status).toBe("succeeded");
    const renderStep = live.steps.find((s) => s.step_key === "render");
    // Raw transform body — NOT wrapped in an envelope.
    expect(renderStep?.output_preview).toEqual({
      markdown: "# Title",
      slug: "title",
      title: "Title",
    });
  });

  test("replaying the cached fixture yields the SAME output_preview shape (no extra .data)", async () => {
    // The dry-run cache builds the fixture exactly like this:
    // envelope = { data: <previous output_preview>, ... }
    const rawPreview = { markdown: "# Title", slug: "title", title: "Title" };
    const fixtureEnvelope = { data: rawPreview, duration_ms: 0, error: null };

    const replayed = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: DRAFT },
      input: null,
      options: { step_output_fixtures: { render: fixtureEnvelope } },
    });
    expect(replayed.status).toBe("succeeded");
    const renderStep = replayed.steps.find((s) => s.step_key === "render");

    // The replayed summary's output_preview must equal the RAW body — the same
    // shape the live run produced. Pre-fix this was the whole envelope
    // `{ data: {…}, duration_ms, error }`, so the next fixture became
    // `{ data: { data: {…} } }` and `$scope.render.data` drifted to
    // `.data.data`.
    expect(renderStep?.output_preview).toEqual(rawPreview);
    expect((renderStep?.output_preview as Record<string, unknown>)?.data).toBeUndefined();
  });

  test("two consecutive fixture replays do not deepen the envelope", async () => {
    const rawPreview = { slug: "title" };
    let envelope: Record<string, unknown> = { data: rawPreview, duration_ms: 0, error: null };

    for (let rerun = 0; rerun < 3; rerun++) {
      const run = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "draft", definition: DRAFT },
        input: null,
        options: { step_output_fixtures: { render: envelope } },
      });
      const preview = run.steps.find((s) => s.step_key === "render")?.output_preview as Record<
        string,
        unknown
      >;
      // output_preview stays the raw body on every rerun — `.slug` reachable
      // at the same depth, never nesting under `.data`.
      expect(preview?.slug).toBe("title");
      expect(preview?.data).toBeUndefined();
      // Rebuild the next fixture the way the dry-run cache does.
      envelope = { data: preview, duration_ms: 0, error: null };
    }
  });
});
