import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../config/loader.ts";
import { emitRequestEvent, type RequestEventPayload } from "./analytics.ts";

const SAMPLE_PAYLOAD: RequestEventPayload = {
  method: "GET",
  path: "/v1/workflows",
  status_code: 200,
  duration_ms: 42,
  request_source: "api",
  tenant_id: "tenant-test",
};

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let server: ReturnType<typeof Bun.serve>;
let ingestUrl = "";
let captured: CapturedRequest[] = [];

async function waitForCaptured(n: number, budgetMs = 500): Promise<void> {
  const deadline = Date.now() + budgetMs; // allow-wall-clock: poll deadline
  while (captured.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5)); // allow-wall-clock: I/O poll
  }
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30)); // allow-wall-clock: I/O flush
}

async function ensureConfig(): Promise<void> {
  try {
    const { getConfig } = await import("../config/loader.ts");
    getConfig();
  } catch {
    const dir = mkdtempSync(join(tmpdir(), "subkit-cfg-analytics-test-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/unit-test", NODE_ENV: "test" },
      configPathOverride: join(dir, "subkit.config.json"),
    });
  }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      captured.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      return new Response(null, { status: 200 });
    },
  });
  ingestUrl = `http://127.0.0.1:${server.port}/ingest`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  await ensureConfig();
  captured = [];
});

afterEach(() => {
  _resetConfigForTests();
});

describe("emitRequestEvent — no-op when analytics is disabled", () => {
  it("issues zero requests when enabled=false (default)", async () => {
    await setConfigKey("observability.analytics.enabled", false, { force: true });
    await setConfigKey("observability.analytics.endpoint", ingestUrl, { force: true });

    emitRequestEvent(SAMPLE_PAYLOAD);
    await settle();

    expect(captured.length).toBe(0);
  });

  it("issues zero requests when endpoint is empty even if enabled=true", async () => {
    await setConfigKey("observability.analytics.enabled", true, { force: true });
    await setConfigKey("observability.analytics.endpoint", "", { force: true });

    emitRequestEvent(SAMPLE_PAYLOAD);
    await settle();

    expect(captured.length).toBe(0);
  });

  it("issues zero requests when both enabled=false and endpoint is empty", async () => {
    await setConfigKey("observability.analytics.enabled", false, { force: true });
    await setConfigKey("observability.analytics.endpoint", "", { force: true });

    emitRequestEvent(SAMPLE_PAYLOAD);
    await settle();

    expect(captured.length).toBe(0);
  });

  it("posts exactly one event when analytics is fully configured and enabled", async () => {
    await setConfigKey("observability.analytics.enabled", true, { force: true });
    await setConfigKey("observability.analytics.endpoint", ingestUrl, { force: true });
    await setConfigKey("observability.analytics.api_key", "test-api-key", { force: true });
    await setConfigKey("observability.analytics.project", "test-project", { force: true });

    emitRequestEvent(SAMPLE_PAYLOAD);
    await waitForCaptured(1);

    expect(captured.length).toBe(1);

    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(ingestUrl);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.authorization).toBe("Bearer test-api-key");

    const body = JSON.parse(req.body) as {
      event: string;
      project: string;
      properties: RequestEventPayload;
    };
    expect(body.event).toBe("http_request");
    expect(body.project).toBe("test-project");
    expect(body.properties.path).toBe("/v1/workflows");
    expect(body.properties.status_code).toBe(200);
  });

  it("returns synchronously (does not stall the caller) when disabled", () => {
    const returned = emitRequestEvent(SAMPLE_PAYLOAD);
    expect(returned).toBeUndefined();
  });
});
