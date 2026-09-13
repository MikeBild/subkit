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
      language: "javascript" as const,
      expression: 'return { markdown: "# Title", slug: "title", title: "Title" };',
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
    expect((renderStep!.output_preview as Record<string, unknown>)?.data).toBeUndefined();
  });

  test("a fixture payload larger than the 512-byte inline preview cap survives replay untruncated", async () => {
    // Guard: `previewOf` (offload.ts) slices step results to a 512-byte
    // inline text preview when serializing for the LLM/DB. That truncation
    // must stay a serialization-only concern — a downstream step reading a
    // replayed fixture must see the FULL payload, and the re-recorded
    // output_preview must be the full raw body, or a preview→rerun loop
    // silently loses data past the cap.
    const bigText = "x".repeat(4096);
    const rawPreview = { blob: bigText, items: Array.from({ length: 32 }, (_, i) => ({ i })) };
    const fixtureEnvelope = { data: rawPreview, duration_ms: 0, error: null };

    const draft = {
      name: "big-fixture",
      steps: [
        {
          kind: "transform" as const,
          id: "render",
          language: "javascript" as const,
          expression: "return { should_be: 'replaced by fixture' };",
        },
        {
          kind: "transform" as const,
          id: "measure",
          language: "javascript" as const,
          expression:
            "const d = input.scope.render.data; return { blob_len: d.blob.length, item_count: d.items.length, last_i: d.items[d.items.length - 1].i };",
        },
      ],
    };

    const run = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: draft },
      input: null,
      options: { step_output_fixtures: { render: fixtureEnvelope } },
    });
    expect(run.status).toBe("succeeded");

    // The downstream transform saw the FULL payload, not a 512-byte slice.
    const measured = run.steps.find((s) => s.step_key === "measure")?.output_preview as {
      blob_len: number;
      item_count: number;
      last_i: number;
    };
    expect(measured).toEqual({ blob_len: 4096, item_count: 32, last_i: 31 });

    // And the re-recorded preview of the replayed step is the untruncated
    // raw body — the next rerun's fixture would carry everything.
    const replayedPreview = run.steps.find((s) => s.step_key === "render")
      ?.output_preview as typeof rawPreview;
    expect(replayedPreview.blob.length).toBe(4096);
    expect(replayedPreview.items).toHaveLength(32);
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
