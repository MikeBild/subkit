// Smoke tests for the TCP passthrough relay.
// Spins up a plain TCP server on an ephemeral port and verifies the
// agent-side relay writes the payload, reads the response, and surfaces
// errors on connection failure.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { tcpRelay } from "../tcp-relay.ts";

let server: net.Server;
let port: number;

beforeAll(async () => {
  server = net.createServer((sock) => {
    sock.on("data", (chunk: Buffer) => {
      // Simple echo service with a fixed prefix so we can tell the
      // difference between "server responded" and "we got our own bytes
      // looped back by a misconfiguration".
      sock.write(Buffer.concat([Buffer.from("ECHO: "), chunk]));
      sock.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("tcpRelay", () => {
  test("writes payload and reads the echoed response", async () => {
    const payload = Buffer.from("hello").toString("base64");
    const res = await tcpRelay({
      host: "127.0.0.1",
      port,
      body: payload,
      timeoutMs: 2_000,
    });
    expect(res.status).toBe(200);
    expect(res.error).toBeNull();
    expect(res.body).not.toBeNull();
    const decoded = Buffer.from(res.body!, "base64").toString("utf8");
    expect(decoded).toBe("ECHO: hello");
  });

  test("returns an error when the target refuses the connection", async () => {
    const res = await tcpRelay({
      host: "127.0.0.1",
      port: 1, // reserved; should refuse.
      body: null,
      timeoutMs: 1_000,
    });
    expect(res.status).toBe(0);
    expect(res.error).not.toBeNull();
  });
});
