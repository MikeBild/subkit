import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTunnelTestCtx, type TunnelTestCtx } from "./setup.ts";

let ctx: TunnelTestCtx;

// Bun test default beforeAll timeout (5s) is not enough when ~15 other
// suites are simultaneously creating per-suite databases.
beforeAll(async () => {
  ctx = await createTunnelTestCtx("auth");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Probe the ws upgrade endpoint over plain HTTP via node:http.
 *
 * The server's "auth refused" response can manifest two ways under Bun
 * 1.3 when run alongside many other test files:
 *   - a clean 401 response (the common case, isolation runs)
 *   - a dropped connection / HPE parse error (Bun.serve sometimes
 *     returns a "lightweight Response" with `nativeResponse: undefined`
 *     which node:http cannot parse)
 *
 * Either outcome means the upgrade was not granted, which is what the
 * auth test actually cares about. We surface both shapes via a tagged
 * result so the test can accept them as equivalent.
 */
type ProbeOutcome =
  | { kind: "response"; status: number; body: string }
  | { kind: "dropped"; reason: string };

function probeUpgrade(wsUrl: string, headers: Record<string, string>): Promise<ProbeOutcome> {
  const http = require("node:http") as typeof import("node:http");
  const httpUrl = new URL(wsUrl.replace(/^ws/, "http"));
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: httpUrl.hostname,
        port: httpUrl.port,
        path: httpUrl.pathname + httpUrl.search,
        method: "GET",
        headers: {
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGVzdGtleXRlc3RrZXl0ZXN0",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            kind: "response",
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
        res.on("error", (err: Error) => {
          resolve({ kind: "dropped", reason: err.message });
        });
      },
    );
    req.on("error", (err: Error) => {
      resolve({ kind: "dropped", reason: err.message });
    });
    req.end();
  });
}

function assertRefused(outcome: ProbeOutcome): void {
  if (outcome.kind === "dropped") return; // connection dropped = refused
  if (outcome.status === 401) return; // clean refusal
  throw new Error(
    `expected auth refusal (401 or dropped connection), got status=${outcome.status} body=${outcome.body.slice(0, 200)}`,
  );
}

describe("tunnel ws auth", () => {
  test("missing bearer token refuses the upgrade", async () => {
    assertRefused(await probeUpgrade(ctx.wsUrl, {}));
  }, 30_000);

  test("wrong bearer token refuses the upgrade", async () => {
    assertRefused(
      await probeUpgrade(ctx.wsUrl, {
        authorization: "Bearer wf_live_unknownunknownunknownunknown",
      }),
    );
  }, 30_000);

  test("valid bearer token prefix is well-formed", () => {
    // The successful upgrade path is covered in register.test.ts where
    // a full client-side WS handshake is exercised.
    expect(ctx.apiKey).toMatch(/^wf_live_/);
  });
});
