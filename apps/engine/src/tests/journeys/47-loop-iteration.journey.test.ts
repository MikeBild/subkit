// User story: As an operator, I want loop steps to actually iterate over
// each item in a collection, so that I can process lists of items inside
// a workflow without writing N separate request steps.
//
// Acceptance criteria:
//   - AC1: The loop body runs once per item in the collection.
//   - AC2: The `$item` binding is accessible inside the body step scope.
//   - AC3: `$loop_index` is injected and increments correctly.
//   - AC4: Body steps are skipped in the linear walk (not double-executed).
//   - AC5: Workflow status is "succeeded" when all iterations complete.
//   - AC6: A loop whose body produces large (offloaded) payloads still
//          succeeds end-to-end; the final output is correct plain JSON
//          (no OffloadRef discriminant leaks through the REST surface).
// Spec refs: plan docs — §2e LOOP STEP: Actual Item Iteration

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { containsOffloadRef } from "../../execution/offload-rehydrate.ts";
import { STEP_RESULT_DB_BYTES } from "../../execution/timeouts.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

// Payload large enough to trigger the offload path inside the engine.
// This is the JOURNEY layer — we want to prove that the REST surface
// returns plain JSON even when the engine used OffloadRefs internally.
const OFFLOAD_BLOB = "z".repeat(STEP_RESULT_DB_BYTES + 512);

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("loop-iteration");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("47: Loop step — iterates items, injects $item and $loop_index", () => {
  test("AC1+AC2+AC5: body runs once per item, $item accessible, status succeeded", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-double",
        slug: "loop-double",
        steps: [
          // Produces the collection to iterate.
          {
            kind: "transform",
            id: "get_numbers",
            language: "javascript",
            expression: "return [1, 2, 3];",
          },
          // Loop over the collection; body step runs for each item.
          {
            kind: "loop",
            id: "process_numbers",
            over: "get_numbers.data",
            body: ["double_num"],
          },
          // Body step: doubles the current item via the canonical $item binding.
          {
            kind: "transform",
            id: "double_num",
            language: "javascript",
            expression: "return input.scope.$item * 2;",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as {
      status: string;
      output: unknown;
      steps: Array<{ step_key: string; status: string }>;
    };

    expect(body.status).toBe("succeeded");

    // Loop output is an array of per-iteration body results.
    const loopOutput = body.output as Array<Record<string, number>>;
    expect(Array.isArray(loopOutput)).toBe(true);
    expect(loopOutput).toHaveLength(3);
    expect((loopOutput[0]?.double_num as { data: number } | undefined)?.data).toBe(2);
    expect((loopOutput[1]?.double_num as { data: number } | undefined)?.data).toBe(4);
    expect((loopOutput[2]?.double_num as { data: number } | undefined)?.data).toBe(6);
  });

  test("AC3: $loop_index increments per iteration", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-index",
        slug: "loop-index",
        steps: [
          {
            kind: "transform",
            id: "get_items",
            language: "javascript",
            expression: "return ['a', 'b', 'c'];",
          },
          {
            kind: "loop",
            id: "tag_items",
            over: "get_items.data",
            body: ["build_tag"],
          },
          {
            kind: "transform",
            id: "build_tag",
            language: "javascript",
            // Produces { index: 0|1|2, letter: "a"|"b"|"c" }
            expression: "return { index: input.scope.$loop_index, letter: input.scope.$item };",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { output: unknown };
    const out = runBody.output as Array<{
      build_tag: { data: { index: number; letter: string } };
    }>;
    expect(out[0]?.build_tag?.data?.index).toBe(0);
    expect(out[1]?.build_tag?.data?.index).toBe(1);
    expect(out[2]?.build_tag?.data?.index).toBe(2);
  });

  test("AC4: body step is skipped in linear walk (not double-executed)", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-no-double",
        slug: "loop-no-double",
        steps: [
          {
            kind: "transform",
            id: "get_items",
            language: "javascript",
            expression: "return [10, 20];",
          },
          {
            kind: "loop",
            id: "process_items",
            over: "get_items.data",
            body: ["halve"],
          },
          {
            kind: "transform",
            id: "halve",
            language: "javascript",
            expression: "return input.scope.$item / 2;",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      steps: Array<{ step_key: string; status: string }>;
    };

    // "halve" step should appear as skipped in the linear walk,
    // not as "succeeded" — it was already handled inside the loop body.
    const halveLinear = runBody.steps.find((s) => s.step_key === "halve");
    expect(halveLinear?.status).toBe("skipped");
  });

  test("AC6: large-body loop offloads internally; REST surface returns plain JSON (no OffloadRef leaks)", async () => {
    // Start a local mock server that returns a payload exceeding the offload
    // threshold so the engine stores OffloadRefs in its in-memory scope.
    // The REST response from POST /v1/executions must NOT contain any
    // `$offloaded: true` discriminant — that is an internal implementation
    // detail that must never cross the external surface.
    const mockServer: MockServer = await createMockServer((_req, res) =>
      jsonResponse(res, 200, { blob: OFFLOAD_BLOB }),
    );
    const mockBase = mockServer.baseUrl;

    try {
      const createRes = await journeyFetch(ctx, "/v1/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: "loop-offload-journey",
          slug: "loop-offload-journey",
          steps: [
            {
              kind: "transform",
              id: "get_ids",
              language: "javascript",
              expression: "return [{ id: 1 }, { id: 2 }];",
            },
            {
              kind: "loop",
              id: "fetch_large",
              over: "get_ids.data",
              body: ["get_blob"],
            },
            {
              kind: "request",
              id: "get_blob",
              method: "GET",
              // The loop body must reference the iteration item — the
              // mock server replies with the blob for any path.
              url: `${mockBase}/blob/\${item.id}`,
            },
          ],
        }),
      });
      expect(createRes.status).toBe(201);
      const wf = (await createRes.json()) as { id: string };

      const runRes = await journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
      });
      expect(runRes.status).toBe(200);

      const runBody = (await runRes.json()) as {
        status: string;
        output: unknown;
        steps?: Array<{ output_preview?: unknown }>;
      };

      // The run must succeed end-to-end.
      expect(runBody.status).toBe("succeeded");

      // The external REST response must be pure JSON — no OffloadRef
      // discriminant object anywhere in the output tree.
      expect(containsOffloadRef(runBody.output)).toBe(false);

      // Step summaries (`steps[].output_preview`) are ALSO returned over
      // the REST surface. A loop step's preview collapses OffloadRefs to
      // a scalar string marker — neither object discriminant (`$offloaded`
      // dollar form nor `_offloaded` underscore form) may survive. String-
      // search the whole serialized run body to catch a leak past
      // `containsOffloadRef`, which only matches the dollar discriminant.
      const serializedRun = JSON.stringify(runBody);
      expect(serializedRun).not.toContain("$offloaded");
      expect(serializedRun).not.toContain("_offloaded");
      const loopSummary = runBody.steps?.find(
        (s) => (s as { step_key?: string }).step_key === "fetch_large",
      );
      expect(loopSummary).toBeDefined();
      const loopPreview = JSON.stringify(loopSummary?.output_preview ?? null);
      expect(loopPreview).not.toContain("$offloaded");
      expect(loopPreview).not.toContain("_offloaded");

      // The offload preview marker must be REDACTED to the scheme only:
      // `[offloaded:<scheme>://…:<n>B]`. The full `s3://<bucket>/<key>`
      // or `fixture://<uuid>` locator exposes the offload backend layout
      // and must never reach `output_preview` (LLM-readable). A bucket
      // path or a fixture uuid surviving the marker is a leak.
      expect(loopPreview).not.toMatch(/s3:\/\/[^…]/);
      expect(loopPreview).not.toMatch(/fixture:\/\/[0-9a-f]/);

      // The output is the iteration array; each iteration must hold the
      // real blob data, not a truncated preview or reference stub.
      const iterations = runBody.output as Array<{ get_blob: { data: { blob?: string } } }>;
      expect(Array.isArray(iterations)).toBe(true);
      expect(iterations).toHaveLength(2);
      for (const iter of iterations) {
        const blob = iter?.get_blob?.data?.blob;
        expect(typeof blob).toBe("string");
        expect((blob ?? "").length).toBeGreaterThan(STEP_RESULT_DB_BYTES);
      }
    } finally {
      await mockServer.close();
    }
  });
});
