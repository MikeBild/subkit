import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let logPath: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subkit-debug-"));
  logPath = join(tmpDir, "debug.log");
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = originalEnv;
  delete require.cache[require.resolve("../debug.ts")];
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("debug logger", () => {
  it("always writes JSONL to the configured path (no env flag required)", async () => {
    delete process.env.SUBKIT_DEBUG;
    delete process.env.DEBUG;
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    dbg.setDebugVerbose(false);
    dbg.debugLog("http.request", { url: "/v1/x" });
    expect(fs.existsSync(logPath)).toBe(true);
    const obj = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(obj).toMatchObject({ kind: "http.request", url: "/v1/x" });
  });

  it("isDebugVerbose reflects SUBKIT_DEBUG=1", async () => {
    process.env.SUBKIT_DEBUG = "1";
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    expect(dbg.isDebugVerbose()).toBe(true);
  });

  it("isDebugVerbose is off by default", async () => {
    delete process.env.SUBKIT_DEBUG;
    delete process.env.DEBUG;
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    dbg.setDebugVerbose(false);
    expect(dbg.isDebugVerbose()).toBe(false);
  });

  it("debugLogTail returns the last N lines (or [] when missing)", async () => {
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    expect(dbg.debugLogTail(5)).toEqual([]);
    for (let i = 0; i < 10; i++) dbg.debugLog("http.request", { i });
    const tail = dbg.debugLogTail(3);
    expect(tail).toHaveLength(3);
    expect(JSON.parse(tail[2] ?? "{}")).toMatchObject({ i: 9 });
  });

  it("redacts sensitive fields before writing the trace record", async () => {
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
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

  it("scrubs secret-shape tokens (DigitalOcean PAT, JWT) in free-form payloads", async () => {
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    const pat = "dop_v1_a9053683abcdefabcdefabcdefabcdefabcdef";
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefSignature";
    dbg.debugLog("dialog.turn_event", {
      event: { kind: "tool-output", text: `paste ${pat} into the form` },
      cookie_header: `Cookie: session=${jwt}`,
    });
    const raw = fs.readFileSync(logPath, "utf8");
    expect(raw).not.toContain(pat);
    expect(raw).not.toContain(jwt);
    expect(raw).toContain("***REDACTED:pat***");
    expect(raw).toContain("***REDACTED:jwt***");
  });

  it("compacts large file and workflow payload strings before writing", async () => {
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    const markdown = `# Slides\n\n${"content line\n".repeat(400)}`;

    dbg.debugLog("dialog.turn_event", {
      event: {
        kind: "elicit_request",
        input: {
          commit_intent: {
            kind: "run_workflow",
            payload: { input_partial: { markdown } },
          },
        },
      },
    });

    const raw = fs.readFileSync(logPath, "utf8");
    expect(raw).not.toContain("content line\\ncontent line\\ncontent line");
    const obj = JSON.parse(raw);
    expect(obj.event.input.commit_intent.payload.input_partial.markdown).toMatch(
      /^\[truncated \d+ chars sha256=[a-f0-9]{16}\]$/,
    );
  });

  it("rotates the log file when it exceeds 2 MB", async () => {
    process.env.SUBKIT_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(logPath, "x".repeat(2 * 1024 * 1024 + 16), "utf8");

    dbg.debugLog("http.request", { url: "/rotated" });

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    const current = fs.readFileSync(logPath, "utf8");
    expect(current.includes("/rotated")).toBe(true);
    fs.writeFileSync(logPath, "y".repeat(2 * 1024 * 1024 + 16), "utf8");
    dbg.debugLog("http.request", { url: "/rotated-again" });
    expect(fs.existsSync(`${logPath}.2`)).toBe(true);
  });
});
