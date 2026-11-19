import { describe, expect, test } from "bun:test";
import http from "node:http";
import { getConfig, setConfigKey } from "../../apps/engine/src/config/loader.ts";
import { playwrightCrawlStrategy } from "../../apps/engine/src/connectors/discovery/index.ts";
import { boot, closeHttpServer, trackConnections } from "./setup.ts";

async function streamingServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address() as { port: number };
  return { server, port: addr.port };
}

describe("e2e harness isolation", () => {
  test("closeHttpServer completes while a response is still streaming", async () => {
    const { server, port } = await streamingServer();
    const sockets = trackConnections(server as unknown as Parameters<typeof trackConnections>[0]);

    const stream = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: stream.signal });
    expect(res.status).toBe(200);
    expect(sockets.size).toBe(1);

    // allow-wall-clock: the assertion below IS about elapsed real time — that
    // teardown returns promptly instead of spending its full budget. A mocked
    // clock would measure nothing.
    const started = Date.now();
    await closeHttpServer(server as unknown as Parameters<typeof closeHttpServer>[0], sockets);
    // allow-wall-clock: the other half of the elapsed-time measurement above.
    const elapsed = Date.now() - started;
    stream.abort();

    expect(elapsed).toBeLessThan(2_000);
    expect(server.listening).toBe(false);
  }, 30_000);

  test("close() plus closeAllConnections() completes with a stream open on the pinned runtime", async () => {
    const { server, port } = await streamingServer();
    const sockets = trackConnections(server as unknown as Parameters<typeof trackConnections>[0]);
    const stream = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: stream.signal });
    expect(res.status).toBe(200);

    const closed = new Promise<"closed">((resolve) => server.close(() => resolve("closed")));
    server.closeIdleConnections();
    server.closeAllConnections();
    const outcome = await Promise.race([
      closed,
      // allow-wall-clock: proving a callback fires in time needs a bound.
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 1_500)),
    ]);
    expect(outcome).toBe("closed");

    stream.abort();
    for (const socket of [...sockets]) socket.destroy();
    await closed;
  }, 30_000);

  test("cleanup restores server.public_base_url to its pre-boot value", async () => {
    const sentinel = "https://harness-isolation.example.com";
    await (await boot("harness-isolation-warmup", { llm: "mock" })).cleanup();
    const original = getConfig().server.public_base_url;
    await setConfigKey("server.public_base_url", sentinel, { force: true });
    try {
      const env = await boot("harness-isolation-config", { llm: "mock" });
      expect(getConfig().server.public_base_url).toBe(env.baseUrl);
      await env.cleanup();
      expect(getConfig().server.public_base_url).toBe(sentinel);
    } finally {
      await setConfigKey("server.public_base_url", original, { force: true });
    }
  }, 90_000);

  test("the mock track declines browser discovery, and gives it back", async () => {
    const target = "https://example.invalid/docs";
    const env = await boot("harness-isolation-hermetic", { llm: "mock" });
    try {
      expect(await playwrightCrawlStrategy.canHandle(target)).toBe(false);
    } finally {
      await env.cleanup();
    }
    const hostHasPlaywright = await (
      Function("s", "return import(s)") as (s: string) => Promise<unknown>
    )(process.env.SK_PLAYWRIGHT_ENTRY || "playwright").then(
      () => true,
      () => false,
    );
    const optedIn = await boot("harness-isolation-browser", {
      llm: "mock",
      browser_discovery: true,
    });
    try {
      expect(await playwrightCrawlStrategy.canHandle(target)).toBe(hostHasPlaywright);
    } finally {
      await optedIn.cleanup();
    }
  }, 120_000);
});
