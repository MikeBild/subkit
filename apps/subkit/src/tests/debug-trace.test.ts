import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLog, enableRequestTrace, requestTraceLine } from "../debug.ts";

describe("request trace line", () => {
  test("method, path, status, timing and trace id", () => {
    expect(
      requestTraceLine("http.response", {
        method: "GET",
        path: "/ready",
        status: 503,
        duration_ms: 42,
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        url: "https://engine.test/ready?token=secret",
      }),
    ).toBe("subkit: GET /ready 503 42ms trace=4bf92f3577b34da6a3ce929d0e0e4736");
  });

  test("transport errors and other records", () => {
    expect(
      requestTraceLine("http.transport_error", { method: "POST", path: "/v1/x", duration_ms: 9 }),
    ).toBe("subkit: POST /v1/x failed after 9ms");
    expect(requestTraceLine("http.request", { method: "GET", path: "/x" })).toBeNull();
  });
});

describe("request trace output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subkit-trace-"));
    process.env.SUBKIT_DEBUG_FILE = join(dir, "debug.log");
  });
  afterEach(() => {
    enableRequestTrace(null);
    delete process.env.SUBKIT_DEBUG_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  test("prints responses with the client trace id when the engine sent none", () => {
    const lines: string[] = [];
    enableRequestTrace({ write: (text) => lines.push(text) });
    debugLog("http.request", { method: "GET", path: "/health" }, { trace_id: "cli-abc" });
    debugLog(
      "http.response",
      { method: "GET", path: "/health", status: 200, duration_ms: 3, trace_id: null },
      { trace_id: "cli-abc" },
    );
    expect(lines).toEqual(["subkit: GET /health 200 3ms trace=cli-abc\n"]);
  });

  test("never prints secrets that appear in the path", () => {
    const lines: string[] = [];
    enableRequestTrace({ write: (text) => lines.push(text) });
    debugLog("http.response", {
      method: "GET",
      path: "/v1/hooks/sk_live_4f9a8b7c6d5e4f3a2b1c",
      status: 404,
      duration_ms: 5,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("sk_live_4f9a8b7c6d5e4f3a2b1c");
  });

  test("stays silent unless enabled", () => {
    const lines: string[] = [];
    debugLog("http.response", { method: "GET", path: "/health", status: 200, duration_ms: 3 });
    expect(lines).toEqual([]);
  });
});
