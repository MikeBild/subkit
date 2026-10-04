import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let logPath: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-elicit-redact-"));
  logPath = join(tmpDir, "debug.log");
  originalEnv = { ...process.env };
  process.env.SK_DEBUG = "1";
  process.env.SK_DEBUG_FILE = logPath;
});

afterEach(() => {
  process.env = originalEnv;
  delete require.cache[require.resolve("../debug.ts")];
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("EngineClient — elicitation-respond body never hits debug.log", () => {
  test("a secret typed into the respond body is absent from the verbose debug log", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    const secret = "plainlowentropypw";
    const outcome = {
      conversation: {
        id: "c1",
        tenant_id: "t1",
        target_workflow_id: null,
        target_connector_id: null,
        status: "active",
        owner_id: null,
        model: null,
        title: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      events: [{ type: "completed", status: "active" }],
      status: "active",
    };
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_x",
      tenant: "t1",
      fetchImpl: async () => jsonResponse(200, outcome),
    });

    await client.respondElicitation("c1", "elicit-1", { values: { api_token: secret } });

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("http.request");
    expect(log).toContain("elicitation_respond_body");
    expect(log).not.toContain(secret);
  });

  test("a non-respond POST still logs its body verbatim (guard is endpoint-scoped)", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_x",
      tenant: "t1",
      fetchImpl: async () => jsonResponse(200, { ok: true }),
    });
    await client.request("POST", "/v1/conversations", undefined, { title: "my new chat" });
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("my new chat");
    expect(log).not.toContain("elicitation_respond_body");
  });
});
