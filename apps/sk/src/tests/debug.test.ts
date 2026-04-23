import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let logPath: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-debug-"));
  logPath = join(tmpDir, "debug.log");
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = originalEnv;
  // Reset module-level cache between tests by re-importing.
  delete require.cache[require.resolve("../debug.ts")];
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("debug logger", () => {
  it("is off by default — debugLog is a no-op", async () => {
    delete process.env.SK_DEBUG;
    delete process.env.DEBUG;
    process.env.SK_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    dbg.setDebugMode(false);
    dbg.debugLog("http.request", { url: "/v1/x" });
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("activates via SK_DEBUG=1 and writes JSONL to the configured path", async () => {
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    // setDebugMode resets the cache; combined with env=1 it stays on.
    dbg.setDebugMode(true);
    dbg.debugLog("http.request", { url: "/v1/x", status: 500 });
    const raw = fs.readFileSync(logPath, "utf8").trim();
    const obj = JSON.parse(raw);
    expect(obj).toMatchObject({ kind: "http.request", url: "/v1/x", status: 500 });
    expect(typeof obj.seq).toBe("number");
    expect(typeof obj.ts).toBe("string");
  });

  it("debugLogTail returns the last N lines (or [] when missing)", async () => {
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    dbg.setDebugMode(true);
    expect(dbg.debugLogTail(5)).toEqual([]);
    for (let i = 0; i < 10; i++) dbg.debugLog("http.request", { i });
    const tail = dbg.debugLogTail(3);
    expect(tail).toHaveLength(3);
    expect(JSON.parse(tail[2] ?? "{}")).toMatchObject({ i: 9 });
  });

  it("redacts sensitive fields before writing the trace record", async () => {
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    dbg.setDebugMode(true);
    dbg.debugLog("dialog.prompt_resolved", {
      request_headers: { Authorization: "Bearer abc123" },
      request_body: { api_key: "wf_live_secret", nested: { password: "secret123" } },
    });
    const raw = fs.readFileSync(logPath, "utf8").trim();
    const obj = JSON.parse(raw);
    expect(obj.request_headers.Authorization).toBe("***redacted***");
    expect(obj.request_body.api_key).toBe("***redacted***");
    expect(obj.request_body.nested.password).toBe("***redacted***");
  });
});
