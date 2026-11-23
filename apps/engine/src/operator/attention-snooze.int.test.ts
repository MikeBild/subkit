import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../db/schema/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { buildAttention } from "./attention.ts";
import {
  HOUR,
  otherPerson,
  owner,
  tenant_id,
  testDb,
  useAttentionTenant,
  wf,
} from "./attention-fixtures.ts";
import { snoozeAttention, unsnoozeAttention } from "./attention-snooze.ts";
import { attentionSnoozeKey } from "./core/attention.ts";

useAttentionTenant();

const mine = () => ({ tenant_id, user_id: owner.id });

async function heldItem() {
  const attention = await buildAttention(testDb.db, owner);
  const item = attention.items.find((entry) => entry.id === `workflow:${wf.held}`);
  if (!item) throw new Error("expected the held workflow to need attention");
  return item;
}

describe("snoozing an attention item", () => {
  test("hides it for the person who snoozed it, lists it as snoozed, and leaves others alone", async () => {
    const at = new Date(getTestNow());
    const key = attentionSnoozeKey(await heldItem());
    const until = new Date(at.getTime() + 2 * HOUR);
    expect(await snoozeAttention(testDb.db, mine(), { attention_key: key, until }, at)).toEqual({
      ok: true,
      until,
    });

    const own = await buildAttention(testDb.db, owner, { now: at });
    expect(own.items.some((entry) => entry.id === `workflow:${wf.held}`)).toBe(false);
    expect(own.snoozed).toHaveLength(1);
    expect(own.snoozed[0]).toMatchObject({
      id: `workflow:${wf.held}`,
      attention_key: key,
      snoozed_until: until.toISOString(),
    });

    const other = await buildAttention(testDb.db, otherPerson, { now: at });
    expect(other.items.some((entry) => entry.id === `workflow:${wf.held}`)).toBe(true);
    expect(other.snoozed).toEqual([]);

    const [entry] = await testDb.db
      .select({ metadata: auditLog.metadata, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "attention.snoozed")));
    expect(entry?.actor_id).toBe(owner.id);
    expect(entry?.metadata).toMatchObject({ attention_key: key, until: until.toISOString() });
    expect(await unsnoozeAttention(testDb.db, mine(), key)).toBe(true);
  });

  test("the item returns by itself once the snooze has ended", async () => {
    const at = new Date(getTestNow());
    const key = `workflow:${wf.held}|stopped|execution_authority_required`;
    await snoozeAttention(
      testDb.db,
      mine(),
      { attention_key: key, until: new Date(at.getTime() + HOUR) },
      at,
    );
    const after = await buildAttention(testDb.db, owner, {
      now: new Date(at.getTime() + HOUR + 1),
    });
    expect(after.items.some((entry) => entry.id === `workflow:${wf.held}`)).toBe(true);
    expect(after.snoozed).toEqual([]);
  });

  test("ending the snooze shows the item again and is recorded once", async () => {
    const at = new Date(getTestNow());
    const key = `workflow:${wf.held}|stopped|execution_authority_required`;
    await snoozeAttention(
      testDb.db,
      mine(),
      { attention_key: key, until: new Date(at.getTime() + HOUR) },
      at,
    );
    expect(await unsnoozeAttention(testDb.db, mine(), key)).toBe(true);
    expect(await unsnoozeAttention(testDb.db, mine(), key)).toBe(false);
    const attention = await buildAttention(testDb.db, owner, { now: at });
    expect(attention.items.some((entry) => entry.id === `workflow:${wf.held}`)).toBe(true);
    expect(attention.snoozed).toEqual([]);
  });

  test("a snooze into the past or beyond thirty days is refused and stores nothing", async () => {
    const at = new Date(getTestNow());
    const key = `workflow:${wf.held}|stopped|execution_authority_required`;
    expect(await snoozeAttention(testDb.db, mine(), { attention_key: key, until: at }, at)).toEqual(
      { ok: false, reason: "snooze_in_past" },
    );
    expect(
      await snoozeAttention(
        testDb.db,
        mine(),
        { attention_key: key, until: new Date(at.getTime() + 31 * 24 * HOUR) },
        at,
      ),
    ).toEqual({ ok: false, reason: "snooze_too_long" });
    expect((await buildAttention(testDb.db, owner, { now: at })).snoozed).toEqual([]);
  });
});
