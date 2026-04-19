import { describe, expect, test } from "bun:test";
import { runHealth } from "../commands/health.ts";
import { EngineClient } from "../engine-client.ts";

function makeFetch(handler: (url: string, init: RequestInit) => Response) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init ?? {}));
  };
}

function captureStdout(fn: () => Promise<unknown> | unknown): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return Promise.resolve(fn())
    .then(() => chunks.join(""))
    .finally(() => {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    });
}

describe("health command", () => {
  test("health --setup prints both health and setup details", async () => {
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: makeFetch((url) => {
        if (url.endsWith("/v1/health")) {
          return new Response(
            JSON.stringify({
              status: "ok",
              version: "1.2.3",
              db_connected: true,
              uptime_seconds: 12,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            overall_status: "warn",
            issues: [
              {
                id: "public-base-url",
                severity: "warning",
                title: "Public base URL",
                detail: "PUBLIC_BASE_URL missing",
              },
            ],
            recommendations: ["Set PUBLIC_BASE_URL."],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    const out = await captureStdout(() => runHealth(client, false, true));
    expect(out).toContain("status");
    expect(out).toContain("setup_status");
    expect(out).toContain("public-base-url");
  });

  test("health --setup --json emits a combined object", async () => {
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: makeFetch((url) => {
        if (url.endsWith("/v1/health")) {
          return new Response(
            JSON.stringify({
              status: "ok",
              version: "1.2.3",
              db_connected: true,
              uptime_seconds: 12,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ overall_status: "ok", issues: [], recommendations: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    const out = await captureStdout(() => runHealth(client, true, true));
    const body = JSON.parse(out) as { setup: { overall_status: string } };
    expect(body.setup.overall_status).toBe("ok");
  });
});
