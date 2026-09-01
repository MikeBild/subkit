// Size-routing parity: ≤5 MB → inline, >5 MB → batch-create + authenticated PUT + finalize.
//
// The mock intercepts at the `fetchImpl` boundary so we verify the actual
// wire paths without any process spawning.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPath } from "../../commands/files.ts";
import { EngineClient, MAX_INLINE_BYTES } from "../../engine-client.ts";

const FID = "fid_00000000-0000-0000-0000-000000000002";
const NOW = "2026-01-01T00:00:00.000Z";

function makeReadyRow(size: number) {
  return {
    id: FID,
    status: "ready",
    filename: "fixture.bin",
    content_type: "application/octet-stream",
    size_bytes: size,
    sha256: "aabbcc",
    scan_result: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-upload-size-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("uploadPath size routing", () => {
  test("absolute legacy upload URLs never receive the engine bearer token", async () => {
    let authorization: string | null = null;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_must_not_leak",
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(null, { status: 200 });
      },
    });

    await client.putToPresignedUrl(
      "https://object-store.example/upload",
      { "content-length": "1" },
      new Uint8Array([1]),
    );
    expect(authorization).toBeNull();
  });

  test("file ≤ MAX_INLINE_BYTES goes to /v1/files/inline", async () => {
    const paths: string[] = [];
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        paths.push(String(input));
        return new Response(JSON.stringify(makeReadyRow(12)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const fp = join(tmpDir, "small.bin");
    writeFileSync(fp, Buffer.alloc(12, 0x01));

    const row = await uploadPath(client, fp, { quiet: true });

    // Only one HTTP call should occur — the inline POST.
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/v1/files/inline");
    expect(row.id).toBe(FID);
  });

  test("file > MAX_INLINE_BYTES goes batch-create → PUT → finalize", async () => {
    const paths: string[] = [];
    const methods: string[] = [];
    const uploadAuthorizations: string[] = [];

    const LARGE = MAX_INLINE_BYTES + 1;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        paths.push(url);
        methods.push(method);

        if (url.includes("/v1/files/batch-create")) {
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: FID,
                  upload_url: "/v1/files/fid_00000000-0000-0000-0000-000000000002/upload",
                  headers: {},
                  expires_in: 3600,
                  dedup: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (method === "PUT" && url.includes("/upload")) {
          uploadAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
          return new Response(null, { status: 200 });
        }

        if (url.includes("/finalize")) {
          return new Response(JSON.stringify(makeReadyRow(LARGE)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const fp = join(tmpDir, "large.bin");
    // Write exactly MAX_INLINE_BYTES + 1 bytes so the size threshold is crossed.
    writeFileSync(fp, Buffer.alloc(LARGE, 0x42));

    const row = await uploadPath(client, fp, { quiet: true });

    expect(row.id).toBe(FID);
    // batch-create, authenticated PUT, finalize = 3 calls minimum.
    expect(paths.length).toBeGreaterThanOrEqual(3);
    expect(paths.some((p) => p.includes("batch-create"))).toBe(true);
    expect(methods.some((m) => m === "PUT")).toBe(true);
    expect(uploadAuthorizations).toContain("Bearer wf_live_test");
    expect(paths.some((p) => p.includes("finalize"))).toBe(true);
    // The inline endpoint must NOT have been called.
    expect(paths.some((p) => p.includes("/v1/files/inline"))).toBe(false);
  });

  test("dedup hit on streamed path returns existing row without PUT", async () => {
    const paths: string[] = [];
    const methods: string[] = [];

    const LARGE = MAX_INLINE_BYTES + 1;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        paths.push(url);
        methods.push(method);

        if (url.includes("/v1/files/batch-create")) {
          // Engine signals dedup: true — no PUT needed.
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: FID,
                  upload_url: "/never-called",
                  headers: {},
                  expires_in: 3600,
                  dedup: true,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        // getFile call after dedup.
        if (method === "GET" && url.includes(FID)) {
          return new Response(JSON.stringify(makeReadyRow(LARGE)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const fp = join(tmpDir, "large-dedup.bin");
    writeFileSync(fp, Buffer.alloc(LARGE, 0x99));

    const row = await uploadPath(client, fp, { quiet: true });

    expect(row.id).toBe(FID);
    // Must NOT have issued a PUT — the dedup flag short-circuits.
    expect(methods.some((m) => m === "PUT")).toBe(false);
    // Must NOT have called /finalize — dedup path returns the existing row.
    expect(paths.some((p) => p.includes("finalize"))).toBe(false);
  });
});
