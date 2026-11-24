import { describe, expect, test } from "bun:test";
import { collectFileRefs, isFileRef } from "../../utils/file-ref.ts";

const FID_A = "fid_00000000-0000-0000-0000-000000000040";
const FID_B = "fid_00000000-0000-0000-0000-000000000041";

describe("collectFileRefs", () => {
  test("collects fids from flat result", () => {
    const payload = { result: { $file: FID_A } };
    expect(collectFileRefs(payload)).toEqual([FID_A]);
  });

  test("collects fids from nested step outputs", () => {
    const payload = {
      steps: [{ output: { $file: FID_A } }, { output: { nested: { $file: FID_B } } }],
    };
    expect(collectFileRefs(payload)).toEqual([FID_A, FID_B]);
  });

  test("returns empty array when no $file refs present", () => {
    const payload = { result: { text: "no files here" }, status: "completed" };
    expect(collectFileRefs(payload)).toEqual([]);
  });

  test("handles array outputs", () => {
    const payload = { outputs: [{ $file: FID_A }, { value: 42 }, { $file: FID_B }] };
    expect(collectFileRefs(payload)).toEqual([FID_A, FID_B]);
  });
});

describe("isFileRef", () => {
  test("valid fid passes", () => {
    expect(isFileRef({ $file: FID_A })).toBe(true);
  });

  test("wrong prefix fails", () => {
    expect(isFileRef({ $file: "file_abc123" })).toBe(false);
  });

  test("malformed uuid fails", () => {
    expect(isFileRef({ $file: "fid_not-a-uuid" })).toBe(false);
  });

  test("extra keys still valid ($file leaf is terminal)", () => {
    expect(isFileRef({ $file: FID_A })).toBe(true);
  });
});

describe("output-files text rendering", () => {
  test("non-JSON output includes Output files line for each fid", async () => {
    const { EngineClient } = await import("../../engine-client.ts");
    const NOW = "2026-01-01T00:00:00.000Z";
    let fileCallCount = 0;

    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes(FID_A)) {
          fileCallCount++;
          return new Response(
            JSON.stringify({
              id: FID_A,
              status: "ready",
              filename: "report.pdf",
              content_type: "application/pdf",
              size_bytes: 102400,
              sha256: "aa",
              scan_result: null,
              created_at: NOW,
              updated_at: NOW,
              deleted_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const execution: Record<string, unknown> = { result: { $file: FID_A } };
    const fids = new Set<string>();
    for (const ref of collectFileRefs(execution)) fids.add(ref);

    const lines: string[] = [];
    for (const fid of fids) {
      try {
        const row = await client.getFile(fid);
        lines.push(`${fid} (${row.filename}, ${row.size_bytes} B)`);
      } catch {
        lines.push(`${fid} — subkit files download ${fid}`);
      }
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(FID_A);
    expect(lines[0]).toContain("report.pdf");
    expect(fileCallCount).toBe(1);
  });

  test("JSON output shape is unchanged — no Output files key injected", () => {
    const execution: Record<string, unknown> = {
      execution_id: "exec-json",
      status: "completed",
      output: { $file: FID_A },
    };

    const serialized = JSON.stringify(execution);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(["execution_id", "status", "output"]);
    expect((parsed.output as Record<string, unknown>).$file).toBe(FID_A);
    expect("output_files" in parsed).toBe(false);
  });

  test("getFile failure → fallback hint line without crashing", async () => {
    const { EngineClient } = await import("../../engine-client.ts");

    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "not_found", message: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    });

    const fids = new Set<string>([FID_B]);
    const lines: string[] = [];
    for (const fid of fids) {
      try {
        const row = await client.getFile(fid);
        lines.push(`${fid} (${row.filename})`);
      } catch {
        lines.push(`${fid} — subkit files download ${fid}`);
      }
    }

    expect(lines[0]).toContain(FID_B);
    expect(lines[0]).toContain("subkit files download");
  });
});

describe("executions get output files from workflow_run links", () => {
  const INPUT_FID = "fid_00000000-0000-0000-0000-000000000050";
  const GENERATED_FID = "fid_00000000-0000-0000-0000-000000000051";
  const EXECUTION_ID = "00000000-0000-4000-8000-000000000620";
  const NOW = "2026-01-01T00:00:00.000Z";
  const fileRow = (id: string, filename: string, sizeBytes: number) => ({
    id,
    status: "ready",
    filename,
    content_type: "application/pdf",
    size_bytes: sizeBytes,
    sha256: "aa",
    scan_result: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  });
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  test("outputFileIds keeps linked outputs and drops input refs", async () => {
    const { outputFileIds } = await import("../../lib/execution-output-files.ts");
    const execution = {
      id: EXECUTION_ID,
      input: { $file: INPUT_FID },
      result: { $file: INPUT_FID },
    };
    expect(outputFileIds(execution, [{ id: GENERATED_FID }])).toEqual([GENERATED_FID]);
  });

  test("lists the generated file and never the uploaded input", async () => {
    const { EngineClient } = await import("../../engine-client.ts");
    const { executionOutputFileLines } = await import("../../lib/execution-output-files.ts");
    const listUrls: URL[] = [];
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname !== "/v1/files") return jsonResponse(fileRow(INPUT_FID, "upload.csv", 10));
        listUrls.push(url);
        return url.searchParams.get("cursor")
          ? jsonResponse({ items: [], next_cursor: null })
          : jsonResponse({
              items: [fileRow(GENERATED_FID, "invoice.pdf", 2048)],
              next_cursor: "page-2",
            });
      },
    });

    const lines = await executionOutputFileLines(client, {
      id: EXECUTION_ID,
      input: { $file: INPUT_FID },
    });
    const output = lines.join("\n");

    expect(lines).toHaveLength(1);
    expect(output).toContain(GENERATED_FID);
    expect(output).toContain("invoice.pdf");
    expect(output).toContain(`subkit files download ${GENERATED_FID}`);
    expect(output).not.toContain(INPUT_FID);
    expect(listUrls.map((url) => url.searchParams.get("linked_to"))).toEqual([
      `workflow_run:${EXECUTION_ID}`,
      `workflow_run:${EXECUTION_ID}`,
    ]);
  });

  for (const metadataAvailable of [true, false]) {
    test(`preserves result download hints when listing fails and metadata is ${metadataAvailable ? "available" : "unavailable"}`, async () => {
      const { EngineClient } = await import("../../engine-client.ts");
      const { executionOutputFileLines } = await import("../../lib/execution-output-files.ts");
      const client = new EngineClient({
        engine_url: "http://engine.local",
        api_key: "wf_live_test",
        tenant: "t-test",
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (metadataAvailable && url.pathname === `/v1/files/${GENERATED_FID}`) {
            return jsonResponse(fileRow(GENERATED_FID, "invoice.pdf", 2048));
          }
          return jsonResponse({ code: "forbidden", message: "nope" }, 403);
        },
      });
      const execution = {
        id: EXECUTION_ID,
        input: { $file: INPUT_FID },
        result: [{ $file: GENERATED_FID }, { $file: INPUT_FID }],
      };
      expect(await executionOutputFileLines(client, execution)).toEqual([
        `${GENERATED_FID}${metadataAvailable ? " (invoice.pdf, 2.0 KB)" : ""} — subkit files download ${GENERATED_FID}`,
      ]);
    });
  }

  test("falls back quietly when listing linked files fails", async () => {
    const { EngineClient } = await import("../../engine-client.ts");
    const { executionOutputFileLines } = await import("../../lib/execution-output-files.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () => jsonResponse({ code: "forbidden", message: "nope" }, 403),
    });
    const lines = await executionOutputFileLines(client, {
      id: EXECUTION_ID,
      input: { $file: INPUT_FID },
    });
    expect(lines).toEqual([]);
  });
});
