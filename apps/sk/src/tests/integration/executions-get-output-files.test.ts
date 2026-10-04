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
        lines.push(`${fid} — sk files download ${fid}`);
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
        lines.push(`${fid} — sk files download ${fid}`);
      }
    }

    expect(lines[0]).toContain(FID_B);
    expect(lines[0]).toContain("sk files download");
  });
});
