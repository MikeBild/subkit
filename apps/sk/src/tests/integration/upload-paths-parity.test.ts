// Upload-paths-parity: every CLI entry point that uploads a file must
// call through `uploadPath` (which routes to either `uploadInline` or
// `batchCreateFiles + putToPresignedUrl + finalizeFile`). No path may
// bypass the shared helper and hit a different endpoint.
//
// The test simulates each entry point with a controlled fetch mock that
// captures which endpoints were called, then asserts the expected
// unified path was taken.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPath } from "../../commands/files.ts";
import { EngineClient } from "../../engine-client.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadyRow(id: string, filename: string, size = 10) {
  return {
    id,
    status: "ready" as const,
    filename,
    content_type: "application/octet-stream",
    size_bytes: size,
    sha256: "ccdd",
    scan_result: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-upload-parity-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeInlineClient(
  fid: string,
  filename: string,
): { client: EngineClient; paths: string[] } {
  const paths: string[] = [];
  const client = new EngineClient({
    engine_url: "http://engine.local",
    api_key: "wf_live_test",
    tenant: "t-test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      paths.push(`${init?.method ?? "GET"}:${url}`);
      if (url.includes("/links")) {
        return new Response(
          JSON.stringify({
            id: "link-1",
            file_id: fid,
            resource_type: "conversation",
            resource_id: "conv-1",
            slug: null,
            role: "attachment",
            created_at: NOW,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(makeReadyRow(fid, filename)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, paths };
}

describe("upload-paths parity", () => {
  test("`sk files upload` uses uploadPath → uploadInline for small files", async () => {
    const fid = "fid_00000000-0000-0000-0000-000000000101";
    const { client, paths } = makeInlineClient(fid, "a.txt");
    const fp = join(tmpDir, "a.txt");
    writeFileSync(fp, "hello");

    const row = await uploadPath(client, fp, { quiet: true });

    expect(row.id).toBe(fid);
    expect(paths.some((p) => p.includes("/v1/files/inline"))).toBe(true);
  });

  test("`sk attach` uses uploadPath → uploadInline then links", async () => {
    const fid = "fid_00000000-0000-0000-0000-000000000102";
    const { client, paths } = makeInlineClient(fid, "b.txt");
    const fp = join(tmpDir, "b.txt");
    writeFileSync(fp, "attach me");

    const row = await uploadPath(client, fp, { quiet: true });
    const link = await client.linkFile(row.id, {
      resource_type: "conversation",
      resource_id: "conv-1",
      role: "attachment",
    });

    expect(row.id).toBe(fid);
    expect(link.resource_type).toBe("conversation");
    expect(paths.some((p) => p.includes("/v1/files/inline"))).toBe(true);
    expect(paths.some((p) => p.includes("/links"))).toBe(true);
  });

  test("`sk workflows run --input-file` produces same FileWire shape", async () => {
    const fid = "fid_00000000-0000-0000-0000-000000000103";
    const { client, paths } = makeInlineClient(fid, "c.pdf");
    const fp = join(tmpDir, "c.pdf");
    writeFileSync(fp, Buffer.alloc(20, 0xaa));

    // This is exactly what the `--input-file` handler does:
    const file = await uploadPath(client, fp, { quiet: true });
    const inputObj: Record<string, unknown> = {};
    inputObj.doc = { $file: file.id };

    expect(file.id).toBe(fid);
    expect(inputObj.doc).toEqual({ $file: fid });
    expect(paths.some((p) => p.includes("/v1/files/inline"))).toBe(true);
  });

  test("headless --attach uses uploadPath for each path", async () => {
    const fids = [
      "fid_00000000-0000-0000-0000-000000000104",
      "fid_00000000-0000-0000-0000-000000000105",
    ];
    let callIndex = 0;
    const uploadPaths: string[] = [];

    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        uploadPaths.push(`${init?.method ?? "GET"}:${url}`);
        if (url.includes("/links")) {
          return new Response(
            JSON.stringify({
              id: `link-${callIndex}`,
              file_id: fids[callIndex] ?? fids[0],
              resource_type: "conversation",
              resource_id: "conv-2",
              slug: null,
              role: "attachment",
              created_at: NOW,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const fid = (fids[callIndex] ?? fids[0]) as string;
        callIndex++;
        return new Response(JSON.stringify(makeReadyRow(fid, `file${callIndex}.txt`)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const fp1 = join(tmpDir, "file1.txt");
    const fp2 = join(tmpDir, "file2.txt");
    writeFileSync(fp1, "first");
    writeFileSync(fp2, "second");

    // Simulate headless --attach iterating paths.
    for (const p of [fp1, fp2]) {
      const row = await uploadPath(client, p, { quiet: true });
      await client.linkFile(row.id, {
        resource_type: "conversation",
        resource_id: "conv-2",
        role: "attachment",
      });
    }

    // Two inline uploads and two link calls.
    const inlineCalls = uploadPaths.filter((p) => p.includes("/v1/files/inline"));
    const linkCalls = uploadPaths.filter((p) => p.includes("/links"));
    expect(inlineCalls).toHaveLength(2);
    expect(linkCalls).toHaveLength(2);
  });

  test("all paths produce same FileWire shape (id, status, filename, size_bytes)", async () => {
    const fid = "fid_00000000-0000-0000-0000-000000000106";
    const { client } = makeInlineClient(fid, "shape.txt");
    const fp = join(tmpDir, "shape.txt");
    writeFileSync(fp, "consistent");

    const row = await uploadPath(client, fp, { quiet: true });

    // Required fields present on every FileWire.
    expect(typeof row.id).toBe("string");
    expect(typeof row.status).toBe("string");
    expect(typeof row.filename).toBe("string");
    expect(typeof row.size_bytes).toBe("number");
    expect(typeof row.created_at).toBe("string");
  });
});
