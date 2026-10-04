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
    expect(renderStep?.output_preview).toEqual({
      markdown: "# Title",
      slug: "title",
      title: "Title",
    });
  });

  test("replaying the cached fixture yields the SAME output_preview shape (no extra .data)", async () => {
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

    expect(renderStep?.output_preview).toEqual(rawPreview);
    expect((renderStep!.output_preview as Record<string, unknown>)?.data).toBeUndefined();
  });

  test("a fixture payload larger than the 512-byte inline preview cap survives replay untruncated", async () => {
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

    const measured = run.steps.find((s) => s.step_key === "measure")?.output_preview as {
      blob_len: number;
      item_count: number;
      last_i: number;
    };
    expect(measured).toEqual({ blob_len: 4096, item_count: 32, last_i: 31 });

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
      expect(preview?.slug).toBe("title");
      expect(preview?.data).toBeUndefined();
      envelope = { data: preview, duration_ms: 0, error: null };
    }
  });
});
