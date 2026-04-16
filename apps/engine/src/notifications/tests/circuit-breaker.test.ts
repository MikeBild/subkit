// Circuit-breaker state machine tests.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { notificationChannels } from "../../db/schema/notifications.ts";
import {
  __resetBreakers,
  canPass,
  FAILURE_THRESHOLD,
  OPEN_DURATION_MS,
  onFailure,
  onSuccess,
} from "../circuit-breaker.ts";
import { createNotificationCtx, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;

beforeAll(async () => {
  ctx = await createNotificationCtx("breaker");
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(() => {
  __resetBreakers();
});

async function insertChannel(suffix: string) {
  const [row] = await ctx.db
    .insert(notificationChannels)
    .values({
      tenant_id: ctx.tenant_id,
      workspace_id: `W_${suffix}`,
      channel_id: `C_${suffix}`,
      platform: "slack",
    })
    .returning();
  if (!row) throw new Error("seed channel failed");
  return row;
}

async function reload(id: string) {
  const [row] = await ctx.db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .limit(1);
  if (!row) throw new Error("row missing");
  return row;
}

describe("notifications: circuit-breaker", () => {
  test("opens after 10 consecutive failures and persists open_until", async () => {
    const channel = await insertChannel("open");
    const now = 1_700_000_000_000;
    let current = channel;
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      await onFailure(ctx.db, current, now);
      current = await reload(channel.id);
    }
    expect(current.circuit_state).toBe("open");
    expect(current.consecutive_failures).toBe(FAILURE_THRESHOLD);
    expect(current.circuit_open_until).toBeTruthy();
    const openUntil = current.circuit_open_until?.getTime() ?? 0;
    expect(openUntil).toBeGreaterThanOrEqual(now + OPEN_DURATION_MS - 50);

    const gate = canPass(current, now + 10);
    expect(gate.allowed).toBe(false);
    expect(gate.phase).toBe("open");
  });

  test("half-open probe closes on success and re-opens on failure", async () => {
    const channel = await insertChannel("halfopen");
    const t0 = 1_700_000_000_000;
    let current = channel;
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      await onFailure(ctx.db, current, t0);
      current = await reload(channel.id);
    }
    // After the cool-down window the next `canPass` flips to half_open.
    const afterCooldown = t0 + OPEN_DURATION_MS + 1;
    const gate = canPass(current, afterCooldown);
    expect(gate.allowed).toBe(true);
    expect(gate.phase).toBe("half_open");

    // A success closes the breaker and wipes the DB state.
    await onSuccess(ctx.db, channel.id);
    current = await reload(channel.id);
    expect(current.circuit_state).toBe("closed");
    expect(current.consecutive_failures).toBe(0);
    expect(current.circuit_open_until).toBeNull();
  });

  test("failure during half-open re-opens immediately", async () => {
    const channel = await insertChannel("reopen");
    const t0 = 1_700_000_000_000;
    let current = channel;
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      await onFailure(ctx.db, current, t0);
      current = await reload(channel.id);
    }
    // Force the half_open phase.
    const afterCooldown = t0 + OPEN_DURATION_MS + 1;
    canPass(current, afterCooldown);
    await onFailure(ctx.db, current, afterCooldown);
    current = await reload(channel.id);
    expect(current.circuit_state).toBe("open");
    expect(current.consecutive_failures).toBe(FAILURE_THRESHOLD + 1);
    const openUntil = current.circuit_open_until?.getTime() ?? 0;
    expect(openUntil).toBeGreaterThanOrEqual(afterCooldown + OPEN_DURATION_MS - 50);
  });
});
