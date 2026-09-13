// Harness-isolation E2E — the e2e harness is itself under test.
//
// The supported runner (`bun run test:e2e`) gives each FILE its own
// process, but a file boots and tears down repeatedly, so anything a
// suite fails to give back stays visible to the next boot in that file.
// Three such leaks were real and are pinned here:
//
//   1. A booted engine with an open streaming response could not be shut
//      down: `Server.close()` calls back only after every connection ends,
//      and `closeAllConnections()` does not end a connection whose
//      response is still streaming. The teardown budget expired and a
//      live server stayed registered for the rest of the process.
//   2. The process-global `server.public_base_url` config leaf was
//      restored to `""` instead of to its pre-boot value, so a suite that
//      had configured an origin found it silently blanked.
//   3. A suite booted with `llm: "mock"` still reached the public
//      internet and launched Chromium, because the `playwright-crawl`
//      discovery strategy claims any URL at the tail of the chain.
//
// The first two tests drive `closeHttpServer` directly against a bare
// server — no engine needed, and the platform behaviour the workaround
// rests on is asserted rather than assumed. The rest drive
// `boot()`/`cleanup()`, because the teardown IS the subject.

import http from "node:http";

import { describe, expect, test } from "bun:test";

import { getConfig, setConfigKey } from "../../apps/engine/src/config/loader.ts";
import { playwrightCrawlStrategy } from "../../apps/engine/src/connectors/discovery/index.ts";
import { boot, closeHttpServer, trackConnections } from "./setup.ts";

/** A server whose handler starts a response and never ends it. */
async function streamingServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
    // deliberately never res.end() — this is the leak's precondition
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

    // Without destroying the tracked socket this spends the full 5s
    // teardown budget and returns with the server still registered.
    expect(elapsed).toBeLessThan(2_000);
    expect(server.listening).toBe(false);
  }, 30_000);

  test("Bun 1.4 closes a streaming connection through closeAllConnections", async () => {
    const { server, port } = await streamingServer();
    // Observed only — the raw close path below deliberately does not use
    // them; they exist so this test can still release the server.
    const sockets = trackConnections(server as unknown as Parameters<typeof trackConnections>[0]);
    const stream = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: stream.signal });
    expect(res.status).toBe(200);

    const closed = new Promise<"closed">((resolve) => server.close(() => resolve("closed")));
    server.closeIdleConnections();
    server.closeAllConnections();
    const outcome = await Promise.race([
      closed,
      // allow-wall-clock: require the native close callback within the shutdown bound.
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 1_500)),
    ]);
    expect(outcome).toBe("closed");
    expect(server.listening).toBe(false);

    // The pinned runtime fixed the old pending callback. Retain explicit
    // cleanup as defense in depth; the first test still checks our helper.
    stream.abort();
    for (const socket of [...sockets]) socket.destroy();
    await closed;
  }, 30_000);

  test("cleanup restores server.public_base_url to its pre-boot value", async () => {
    const sentinel = "https://harness-isolation.example.com";
    // `boot()` is what bootstraps the engine config loader; running this
    // file alone would otherwise hit `getConfig()` before `loadConfig()`.
    await (await boot("harness-isolation-warmup", { llm: "mock" })).cleanup();
    const original = getConfig().server.public_base_url;
    await setConfigKey("server.public_base_url", sentinel, { force: true });
    try {
      const env = await boot("harness-isolation-config", { llm: "mock" });
      // boot() takes the leaf over for the suite's own origin.
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
      // Declining is what keeps the strategy from launching Chromium and
      // navigating to `target`: the dispatcher records `strategy_skipped`
      // and never calls `fetch`.
      expect(await playwrightCrawlStrategy.canHandle(target)).toBe(false);
    } finally {
      await env.cleanup();
    }
    // Opting in gives the real loader back, so a suite that needs the
    // crawl still gets it. The expected answer is whatever the HOST says —
    // playwright is a dev dependency here but need not be installed
    // everywhere — so resolve it the same indirected way the strategy
    // does. The claim under test is only that the harness stopped forcing
    // the answer to false.
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
