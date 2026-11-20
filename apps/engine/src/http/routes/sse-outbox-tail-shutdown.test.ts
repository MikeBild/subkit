import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { events } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import type { AppEnv } from "../openapi.ts";
import {
  createStreamShutdown,
  SERVER_SHUTDOWN_EVENT,
  type StreamShutdown,
  streamShutdownSignal,
} from "../stream-shutdown.ts";
import { streamOutboxTail } from "./sse-outbox-tail.ts";

let ctx: TestDb;
let tenantId = "";

beforeAll(async () => {
  ctx = await createTestDb("sse-outbox-tail-shutdown");
  tenantId = (await seedTenant(ctx.db, { slug: "stream-shutdown", display_name: "Streams" })).id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

function appFor(shutdown: StreamShutdown, heartbeatMs?: number) {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", ctx.db as never);
    c.set("principal", adminPrincipal(tenantId));
    await next();
  });
  app.get("/stream", (c) =>
    streamOutboxTail(c, {
      db: ctx.db,
      replay: "tail",
      conds: () => [eq(events.tenant_id, tenantId)],
      shutdown: shutdown.signal,
      ...(heartbeatMs ? { heartbeatMs } : {}),
    }),
  );
  return app;
}

async function readFrames(
  response: Response,
  until: (text: string) => boolean,
): Promise<{ text: string; ended: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream has no body");
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return { text, ended: true };
    text += decoder.decode(chunk.value, { stream: true });
    if (until(text)) return { text, ended: false };
  }
}

describe("an open event stream at shutdown", () => {
  test("it says the server is shutting down, ends, and frees its tenant work at once", async () => {
    const shutdown = createStreamShutdown();
    const response = await appFor(shutdown).request("/stream");
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("stream has no body");
    const decoder = new TextDecoder();
    const hello = decoder.decode((await reader.read()).value);
    expect(hello).toContain("event: hello");
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);

    const startedAt = performance.now();
    shutdown.begin();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    const elapsed = performance.now() - startedAt;
    expect(rest).toBe(`event: ${SERVER_SHUTDOWN_EVENT}\ndata: {"reason":"shutdown"}\n\n`);
    expect(elapsed).toBeLessThan(500);
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
  });

  test("several streams end together and a stream opened during shutdown ends after its hello", async () => {
    const shutdown = createStreamShutdown();
    const app = appFor(shutdown, 25_000);
    const open = await Promise.all([app.request("/stream"), app.request("/stream")]);
    const pending = open.map((response) => readFrames(response, () => false));
    await Promise.resolve();
    shutdown.begin();
    shutdown.begin();
    for (const result of await Promise.all(pending)) {
      expect(result.ended).toBe(true);
      expect(result.text).toContain("event: hello");
      expect(
        result.text.endsWith(`event: ${SERVER_SHUTDOWN_EVENT}\ndata: {"reason":"shutdown"}\n\n`),
      ).toBe(true);
    }
    const late = await readFrames(await app.request("/stream"), () => false);
    expect(late.ended).toBe(true);
    expect(late.text).toContain("event: hello");
    expect(late.text).toContain(`event: ${SERVER_SHUTDOWN_EVENT}`);
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
  });

  test("a client that leaves first gets no farewell and the engine-wide signal starts open", async () => {
    const shutdown = createStreamShutdown();
    const abort = new AbortController();
    const response = await appFor(shutdown).request("/stream", { signal: abort.signal });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("stream has no body");
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    await waitFor(() => tenantWorkSnapshot(tenantId).in_flight === 0, {
      sleepMs: 10,
      tries: 100,
      label: "stream work settles",
    });
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
    expect(streamShutdownSignal().aborted).toBe(false);
  });
});
