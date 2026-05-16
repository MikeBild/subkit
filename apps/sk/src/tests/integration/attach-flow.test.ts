// Integration: attach command flow via mocked engine client.
//
// Drives `uploadPath` + `client.linkFile` (the two calls that
// `sk attach` makes) with a controlled fetch mock and asserts the
// link record has the expected shape. The REPL slash handler is
// implemented on top of the same two primitives so the test also
// covers that path indirectly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPath } from "../../commands/files.ts";
import { EngineClient } from "../../engine-client.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const FID = "fid_00000000-0000-0000-0000-000000000010";
const CONV_ID = "conv-00000000-0000-0000-0000-000000000001";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-attach-flow-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("integration: attach flow (upload + link)", () => {
  test("happy path — file uploaded then linked to conversation", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];

    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const bodyStr = init?.body ? String(init.body) : undefined;
        calls.push({ url, method, body: bodyStr ? JSON.parse(bodyStr) : undefined });

        if (url.includes("/v1/files/inline")) {
          return new Response(
            JSON.stringify({
              id: FID,
              status: "ready",
              filename: "fixture.txt",
              content_type: "text/plain",
              size_bytes: 7,
              sha256: "aabb",
              scan_result: null,
              created_at: NOW,
              updated_at: NOW,
              deleted_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url.includes("/links")) {
          return new Response(
            JSON.stringify({
              id: "link-1",
              file_id: FID,
              resource_type: "conversation",
              resource_id: CONV_ID,
              slug: null,
              role: "attachment",
              created_at: NOW,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const fp = join(tmpDir, "fixture.txt");
    writeFileSync(fp, "hello!!");

    const row = await uploadPath(client, fp, { quiet: true });
    expect(row.id).toBe(FID);

    const link = await client.linkFile(FID, {
      resource_type: "conversation",
      resource_id: CONV_ID,
      role: "attachment",
    });

    expect(link.resource_type).toBe("conversation");
    expect(link.resource_id).toBe(CONV_ID);
    expect(link.role).toBe("attachment");

    // Upload call happened first, then the link call.
    expect(calls[0]?.url).toContain("/v1/files/inline");
    expect(calls[1]?.url).toContain("/links");
    expect((calls[1]?.body as Record<string, unknown>)?.resource_type).toBe("conversation");
  });

  test("wrong tenant on link call → 403 SkEngineError", async () => {
    const { SkEngineError } = await import("../../engine-client.ts");

    const fp = join(tmpDir, "fixture2.txt");
    writeFileSync(fp, "data");

    let callIndex = 0;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async () => {
        callIndex++;
        if (callIndex === 1) {
          return new Response(
            JSON.stringify({
              id: FID,
              status: "ready",
              filename: "fixture2.txt",
              content_type: "text/plain",
              size_bytes: 4,
              sha256: "xxyy",
              scan_result: null,
              created_at: NOW,
              updated_at: NOW,
              deleted_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Second call (link) returns 403 — wrong tenant.
        return new Response(JSON.stringify({ code: "forbidden", message: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await uploadPath(client, fp, { quiet: true });
    await expect(
      client.linkFile(FID, { resource_type: "conversation", resource_id: "other-conv" }),
    ).rejects.toBeInstanceOf(SkEngineError);
  });

  test("upload failure short-circuits before link is called", async () => {
    const { SkEngineError } = await import("../../engine-client.ts");
    let linkCalled = false;

    const fp = join(tmpDir, "fail.txt");
    writeFileSync(fp, "x");

    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t-test",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/links")) linkCalled = true;
        return new Response(JSON.stringify({ code: "server_error", message: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    });

    // uploadPath throws on engine error.
    await expect(uploadPath(client, fp, { quiet: true })).rejects.toBeInstanceOf(SkEngineError);
    // The link endpoint must never have been reached.
    expect(linkCalled).toBe(false);
  });
});
