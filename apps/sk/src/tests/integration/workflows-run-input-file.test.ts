// Integration: `sk workflows run --input-file K=<path>` flow.
//
// Validates the full --input-file path end-to-end:
//  1. uploadPath is called → uploadInline hit on the engine
//  2. The returned fid is wrapped as { $file: "fid_..." }
//  3. The runExecution body carries the fid under the expected key
//
// Uses a controlled fetchImpl so no real engine is needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPath } from "../../commands/files.ts";
import { EngineClient } from "../../engine-client.ts";
import { formatFileRef } from "../../utils/file-ref.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const FID = "fid_00000000-0000-0000-0000-000000000030";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-wf-input-file-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeClient(captures: { body?: unknown; paths: string[] }) {
  return new EngineClient({
    engine_url: "http://engine.local",
    api_key: "wf_live_test",
    tenant: "t-test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      captures.paths.push(url);

      if (url.includes("/v1/files/inline")) {
        return new Response(
          JSON.stringify({
            id: FID,
            status: "ready",
            filename: "doc.pdf",
            content_type: "application/pdf",
            size_bytes: 42,
            sha256: "eeff",
            scan_result: null,
            created_at: NOW,
            updated_at: NOW,
            deleted_at: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/v1/executions")) {
        if (init?.body) captures.body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            execution_id: "exec-1",
            status: "completed",
            output: { result: "ok" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}

describe("workflows run --input-file", () => {
  test("uploadInline called and fid injected into execution input", async () => {
    const captures: { body?: unknown; paths: string[] } = { paths: [] };
    const client = makeClient(captures);

    const fp = join(tmpDir, "doc.pdf");
    writeFileSync(fp, Buffer.alloc(42, 0xbb));

    // Simulate what workflows.ts run handler does:
    const file = await uploadPath(client, fp, { quiet: true });
    const inputObj: Record<string, unknown> = { format: "pdf" };
    inputObj.doc = formatFileRef(file.id);

    // Now run the execution with the composed input.
    const execResult = await client.runExecution({
      source: "saved",
      workflow_id: "wf_x",
      input: inputObj,
      request_source: "cli",
    });

    expect(execResult.execution_id).toBe("exec-1");

    // The inline upload must have been called.
    expect(captures.paths.some((p) => p.includes("/v1/files/inline"))).toBe(true);

    // The execution body must have the $file ref under "doc".
    const body = captures.body as Record<string, unknown>;
    expect(body).toBeDefined();
    const input = body.input as Record<string, unknown>;
    expect(input.format).toBe("pdf");
    expect(input.doc).toEqual({ $file: FID });
  });

  test("fid is correctly formatted with FID_RE pattern", async () => {
    const captures: { paths: string[] } = { paths: [] };
    const client = makeClient(captures);

    const fp = join(tmpDir, "shape.bin");
    writeFileSync(fp, "shape");

    const file = await uploadPath(client, fp, { quiet: true });
    const ref = formatFileRef(file.id);

    expect(ref.$file).toMatch(/^fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("multiple --input-file entries each produce a $file ref", async () => {
    const fidA = "fid_aaaaaaaa-0000-0000-0000-000000000031";
    const fidB = "fid_bbbbbbbb-0000-0000-0000-000000000032";
    let callIndex = 0;
    const fids = [fidA, fidB];

    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/v1/files/inline")) {
          const fid = fids[callIndex] ?? fidA;
          callIndex++;
          return new Response(
            JSON.stringify({
              id: fid,
              status: "ready",
              filename: `file${callIndex}.bin`,
              content_type: "application/octet-stream",
              size_bytes: 5,
              sha256: `${callIndex}`,
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

    const fpA = join(tmpDir, "a.bin");
    const fpB = join(tmpDir, "b.bin");
    writeFileSync(fpA, "aaaaa");
    writeFileSync(fpB, "bbbbb");

    const inputObj: Record<string, unknown> = {};
    for (const [key, fp] of [
      ["doc", fpA],
      ["img", fpB],
    ] as const) {
      const file = await uploadPath(client, fp, { quiet: true });
      inputObj[key] = formatFileRef(file.id);
    }

    expect(inputObj.doc).toEqual({ $file: fidA });
    expect(inputObj.img).toEqual({ $file: fidB });
  });

  test("wrong tenant upload fails → upload error propagated", async () => {
    const { EngineError } = await import("@cli-core/errors.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_wrong",
      tenant: "t-wrong",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "forbidden", message: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });

    const fp = join(tmpDir, "deny.bin");
    writeFileSync(fp, "x");
    await expect(uploadPath(client, fp, { quiet: true })).rejects.toBeInstanceOf(EngineError);
  });
});
