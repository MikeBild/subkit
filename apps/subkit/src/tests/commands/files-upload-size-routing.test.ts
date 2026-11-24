import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandDef, runCommand } from "citty";
import { filesCommand, uploadPath } from "../../commands/files.ts";
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
  tmpDir = mkdtempSync(join(tmpdir(), "subkit-upload-size-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("uploadPath size routing", () => {
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
    writeFileSync(fp, Buffer.alloc(LARGE, 0x42));

    const row = await uploadPath(client, fp, { quiet: true });

    expect(row.id).toBe(FID);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    expect(paths.some((p) => p.includes("batch-create"))).toBe(true);
    expect(methods.some((m) => m === "PUT")).toBe(true);
    expect(uploadAuthorizations).toContain("Bearer wf_live_test");
    expect(paths.some((p) => p.includes("finalize"))).toBe(true);
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
    expect(methods.some((m) => m === "PUT")).toBe(false);
    expect(paths.some((p) => p.includes("finalize"))).toBe(false);
  });

  test("dedup: false streams every byte without sending sha256 to batch-create (#586)", async () => {
    const LARGE = MAX_INLINE_BYTES + 1;
    const batchBodies: Array<{ files: Array<Record<string, unknown>> }> = [];
    const finalizeBodies: Array<Record<string, unknown>> = [];
    let uploadedByteCount = 0;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = request.url;
        const method = request.method.toUpperCase();
        if (url.includes("/v1/files/batch-create")) {
          batchBodies.push(await request.json());
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: FID,
                  upload_url: `/v1/files/${FID}/upload`,
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
          uploadedByteCount = (await request.arrayBuffer()).byteLength;
          return new Response(null, { status: 200 });
        }
        if (url.includes("/finalize")) {
          finalizeBodies.push(await request.json());
          return new Response(JSON.stringify(makeReadyRow(LARGE)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const fp = join(tmpDir, "large-no-dedup.bin");
    writeFileSync(fp, Buffer.alloc(LARGE, 0x17));

    const row = await uploadPath(client, fp, { quiet: true, dedup: false });

    expect(row.id).toBe(FID);
    expect(batchBodies).toHaveLength(1);
    expect(batchBodies[0]?.files[0]).not.toHaveProperty("sha256");
    expect(uploadedByteCount).toBe(LARGE);
    expect(finalizeBodies).toHaveLength(1);
    expect(typeof finalizeBodies[0]?.sha256).toBe("string");
  });

  test("dedup: false rejects a dedup answer instead of returning the existing file (#586)", async () => {
    const LARGE = MAX_INLINE_BYTES + 1;
    const methods: string[] = [];
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        methods.push(
          (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
        );
        if (url.includes("/v1/files/batch-create")) {
          return new Response(
            JSON.stringify({
              files: [{ id: FID, upload_url: "", headers: {}, expires_in: 3600, dedup: true }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(makeReadyRow(LARGE)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const fp = join(tmpDir, "large-no-dedup-hit.bin");
    writeFileSync(fp, Buffer.alloc(LARGE, 0x18));

    await expect(uploadPath(client, fp, { quiet: true, dedup: false })).rejects.toThrow(/dedup/);
    expect(methods.filter((method) => method === "GET")).toHaveLength(0);
  });
});

describe("sk files upload --no-dedup (#586)", () => {
  const envKeys = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.SUBKIT_ENGINE_URL = "https://engine.test";
    process.env.SUBKIT_API_KEY = "test-key";
    process.env.SUBKIT_TENANT = "test-tenant";
  });
  afterEach(() => {
    for (const key of envKeys) {
      const savedValue = savedEnv[key];
      if (savedValue === undefined) delete process.env[key];
      else process.env[key] = savedValue;
    }
  });

  const runUpload = async (rawArgs: string[]) => {
    const batchRequests: Array<Parameters<EngineClient["batchCreateFiles"]>[0]> = [];
    const batchSpy = spyOn(EngineClient.prototype, "batchCreateFiles").mockImplementation(
      async (request) => {
        batchRequests.push(request);
        return {
          files: [
            {
              id: FID,
              upload_url: `/v1/files/${FID}/upload`,
              headers: {},
              expires_in: 3600,
              dedup: false,
            },
          ],
        } as Awaited<ReturnType<EngineClient["batchCreateFiles"]>>;
      },
    );
    const putSpy = spyOn(EngineClient.prototype, "putUploadBytes").mockResolvedValue(
      undefined as never,
    );
    const finalizeSpy = spyOn(EngineClient.prototype, "finalizeFile").mockResolvedValue(
      makeReadyRow(MAX_INLINE_BYTES + 1) as Awaited<ReturnType<EngineClient["finalizeFile"]>>,
    );
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    const fp = join(tmpDir, "cli-large.bin");
    writeFileSync(fp, Buffer.alloc(MAX_INLINE_BYTES + 1, 0x21));
    try {
      const subCommands = filesCommand.subCommands as Record<string, CommandDef>;
      await runCommand(subCommands.upload as CommandDef, { rawArgs: [fp, "--quiet", ...rawArgs] });
    } finally {
      batchSpy.mockRestore();
      putSpy.mockRestore();
      finalizeSpy.mockRestore();
      writeSpy.mockRestore();
    }
    return batchRequests;
  };

  test("--no-dedup leaves sha256 out of batch-create", async () => {
    const batchRequests = await runUpload(["--no-dedup"]);
    expect(batchRequests).toHaveLength(1);
    expect(batchRequests[0]?.files[0]).not.toHaveProperty("sha256");
  });

  test("without --no-dedup the sha256 dedup probe stays on", async () => {
    const batchRequests = await runUpload([]);
    expect(batchRequests).toHaveLength(1);
    expect(typeof batchRequests[0]?.files[0]?.sha256).toBe("string");
  });
});
