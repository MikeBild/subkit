import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { TunnelCapacityError, TunnelTimeoutError } from "../types.ts";
import { createTunnelTestCtx, type TunnelTestCtx } from "./setup.ts";

let ctx: TunnelTestCtx;

beforeAll(async () => {
  ctx = await createTunnelTestCtx("timeout");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

describe("tunnel registry limits", () => {
  test("forward times out when agent never replies, and concurrency cap rejects excess", async () => {
    const ws = new WebSocket(ctx.wsUrl, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "register",
            agent_version: "test",
            targets: [{ name: "silent", local_base_url: "http://127.0.0.1:65535/" }],
          }),
        );
      });
      ws.once("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string };
        if (frame.type === "register_ack") resolve();
        else reject(new Error("no ack"));
      });
      ws.once("error", reject);
    });

    // Shrink the per-target cap so we can prove capacity rejection.
    const entry = ctx.registry.get(ctx.tenantId, "silent");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("no entry");
    entry.concurrency_cap = 1;

    // Kick off one request — with a 150ms timeout — that the agent will ignore.
    const p1 = ctx.registry
      .forwardRequest(
        ctx.tenantId,
        "silent",
        { target: "silent", method: "GET", path: "/", headers: {}, body: null },
        { timeoutMs: 150 },
      )
      .catch((err) => err);

    // Immediately fire a second request; the cap is 1 so we should see capacity.
    let capacityError: unknown = null;
    try {
      await ctx.registry.forwardRequest(
        ctx.tenantId,
        "silent",
        { target: "silent", method: "GET", path: "/", headers: {}, body: null },
        { timeoutMs: 1000 },
      );
    } catch (err) {
      capacityError = err;
    }
    expect(capacityError).toBeInstanceOf(TunnelCapacityError);

    const first = (await p1) as unknown;
    expect(first).toBeInstanceOf(TunnelTimeoutError);

    ws.close();
  });
});
