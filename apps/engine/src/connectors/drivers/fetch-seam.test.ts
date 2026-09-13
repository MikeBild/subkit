// Durable fix for the 2026-06-21 Gmail send outage: driver egress must
// NOT reuse a pooled keep-alive connection (a poisoned half-open pooled
// HTTP/2 connection to gmail.googleapis.com hung every send for hours
// until a manual restart). The production `getDriverFetch()` forces a
// fresh connection per request via `keepalive: false`.
//
// This test proves it behaviourally: N sequential driver-egress requests
// to a connection-counting server must open N distinct TCP connections.
// (A plain pooled fetch would open 1.)

import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getDriverFetch } from "./fetch-seam.ts";

let server: Server;
let baseUrl: string;
let connections = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.end("ok");
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no server port");
  baseUrl = `http://127.0.0.1:${addr.port}/`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  connections = 0;
});

describe("driver egress · no connection pooling (keepalive:false)", () => {
  test("N sequential driver-egress requests open N fresh TCP connections", async () => {
    const fetchImpl = getDriverFetch();
    const N = 5;
    for (let i = 0; i < N; i++) {
      const res = await fetchImpl(baseUrl);
      await res.text();
    }
    // A poisoned pooled connection caused the outage; with keepalive:false
    // every request gets a fresh connection, so a half-open one can never
    // be reused. Pooled fetch would yield 1.
    expect(connections).toBe(N);
  });

  test("the keepalive:false policy wins even when a caller passes keepalive:true", async () => {
    // The override is unconditional; a caller-supplied keepalive:true must NOT
    // re-enable pooling (it only triggers the fetch.keepalive_override warn).
    const fetchImpl = getDriverFetch();
    const N = 4;
    for (let i = 0; i < N; i++) {
      const res = await fetchImpl(baseUrl, { keepalive: true });
      await res.text();
    }
    expect(connections).toBe(N);
  });
});
