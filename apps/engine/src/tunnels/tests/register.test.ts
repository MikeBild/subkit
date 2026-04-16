import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import WebSocket from "ws";
import { tunnels, tunnelTargets } from "../../db/schema/index.ts";
import { createTunnelTestCtx, type TunnelTestCtx } from "./setup.ts";

let ctx: TunnelTestCtx;

beforeAll(async () => {
  ctx = await createTunnelTestCtx("register");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

describe("tunnel register", () => {
  test("agent connects, registers, tunnels + targets rows materialise", async () => {
    const ws = new WebSocket(ctx.wsUrl, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const tunnelIdPromise = new Promise<string>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "register",
            agent_version: "test-1.0.0",
            targets: [{ name: "alpha", local_base_url: "http://127.0.0.1:65535/" }],
          }),
        );
      });
      ws.once("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; tunnel_id?: string };
        if (frame.type === "register_ack" && frame.tunnel_id) {
          resolve(frame.tunnel_id);
        } else {
          reject(new Error(`unexpected frame ${JSON.stringify(frame)}`));
        }
      });
      ws.once("error", reject);
    });
    const tunnelId = await tunnelIdPromise;
    expect(tunnelId).toBeTruthy();

    // Row should exist in `tunnels` + one `tunnel_targets` row.
    const rows = await ctx.testDb.db
      .select()
      .from(tunnels)
      .where(and(eq(tunnels.tenant_id, ctx.tenantId), eq(tunnels.id, tunnelId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("connected");

    const targetRows = await ctx.testDb.db
      .select()
      .from(tunnelTargets)
      .where(eq(tunnelTargets.tunnel_id, tunnelId));
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]?.target_name).toBe("alpha");

    // Registry exposes the live slot.
    expect(ctx.registry.get(ctx.tenantId, "alpha")).toBeDefined();

    ws.close();
  });
});
