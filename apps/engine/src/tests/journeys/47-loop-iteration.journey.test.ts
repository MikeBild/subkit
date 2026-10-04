import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { containsOffloadRef } from "../../execution/offload-rehydrate.ts";
import { STEP_RESULT_DB_BYTES } from "../../execution/timeouts.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

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
          {
            kind: "transform",
            id: "get_numbers",
            language: "javascript",
            expression: "return [1, 2, 3];",
          },
          {
            kind: "loop",
            id: "process_numbers",
            over: "get_numbers.data",
            body: ["double_num"],
          },
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

    const loopOutput = body.output as Array<Record<string, number>>;
    expect(Array.isArray(loopOutput)).toBe(true);
    expect(loopOutput).toHaveLength(3);
    expect((loopOutput[0]!.double_num as { data: number } | undefined)?.data).toBe(2);
    expect((loopOutput[1]!.double_num as { data: number } | undefined)?.data).toBe(4);
    expect((loopOutput[2]!.double_num as { data: number } | undefined)?.data).toBe(6);
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

    const halveLinear = runBody.steps.find((s) => s.step_key === "halve");
    expect(halveLinear?.status).toBe("skipped");
  });

  test("AC6: large-body loop offloads internally; REST surface returns plain JSON (no OffloadRef leaks)", async () => {
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

      expect(runBody.status).toBe("succeeded");

      expect(containsOffloadRef(runBody.output)).toBe(false);

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

      expect(loopPreview).not.toMatch(/s3:\/\/[^…]/);
      expect(loopPreview).not.toMatch(/fixture:\/\/[0-9a-f]/);

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
