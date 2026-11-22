import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let logPath: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subkit-engine-recovery-"));
  logPath = join(tmpDir, "debug.log");
  originalEnv = { ...process.env };
  process.env.SUBKIT_DEBUG = "1";
  process.env.SUBKIT_DEBUG_FILE = logPath;
});

afterEach(() => {
  process.env = originalEnv;
  delete require.cache[require.resolve("../debug.ts")];
  delete require.cache[require.resolve("../repl/error-humanize.ts")];
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function makeEconnResetError(): Error {
  const e = new Error(
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  );
  (e as { code?: string }).code = "ECONNRESET";
  return e;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("EngineClient.respondElicitation recovery", () => {
  test("ECONNRESET on first POST + 200 on retry succeeds normally", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    const successOutcome = {
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
    let attempt = 0;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_x",
      tenant: "t1",
      fetchImpl: async () => {
        attempt++;
        if (attempt === 1) throw makeEconnResetError();
        return jsonResponse(200, successOutcome);
      },
    });

    const out = await client.respondElicitation("c1", "elicit-1", { confirmed: true });
    expect(attempt).toBe(2);
    expect(out.status).toBe("active");
    expect(out.conversation.id).toBe("c1");
    expect((out as { __recovered?: boolean }).__recovered).toBeUndefined();
  });

  test("ECONNRESET + 409 elicitation_already_resolved → synthesised recovered outcome", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    const conversationDetail = {
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
        updated_at: "2026-01-01T00:00:01Z",
      },
      messages: [],
      tool_calls: [],
      draft: null,
      approvals: [],
    };
    let postAttempts = 0;
    let getCalls = 0;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_x",
      tenant: "t1",
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.includes("/respond")) {
          postAttempts++;
          if (postAttempts === 1) throw makeEconnResetError();
          return jsonResponse(409, {
            code: "elicitation_already_resolved",
            message: "elicitation already resolved",
            details: { previous_status: "approved" },
          });
        }
        if (url.endsWith("/v1/conversations/c1")) {
          getCalls++;
          return jsonResponse(200, conversationDetail);
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });

    const out = await client.respondElicitation("c1", "elicit-1", { confirmed: true });
    expect(postAttempts).toBe(2);
    expect(getCalls).toBe(1);
    expect((out as { __recovered?: boolean }).__recovered).toBe(true);
    expect(out.conversation.id).toBe("c1");
    expect(out.events.length).toBe(1);
    expect((out.events[0] as { type: string }).type).toBe("completed");
  });

  test("non-transient errors propagate without retry (e.g. 500)", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    let attempts = 0;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_x",
      tenant: "t1",
      fetchImpl: async () => {
        attempts++;
        return jsonResponse(500, { code: "internal_error", message: "boom" });
      },
    });

    await expect(client.respondElicitation("c1", "elicit-1", {})).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test("ECONNRESET + ECONNRESET on retry rethrows the second error", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    let attempts = 0;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_x",
      tenant: "t1",
      fetchImpl: async () => {
        attempts++;
        throw makeEconnResetError();
      },
    });

    await expect(client.respondElicitation("c1", "elicit-1", {})).rejects.toThrow(
      /socket connection was closed/,
    );
    expect(attempts).toBe(2);
  });
});
