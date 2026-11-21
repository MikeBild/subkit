import { expect, spyOn, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import * as attention from "../../operator/attention.ts";
import { EVENT_CATALOG } from "../events/catalog.ts";
import {
  shouldDispatchCockpitPushAttention,
  triggerCockpitPushAttention,
} from "./cockpit-push-attention.ts";

test("Cockpit push only wakes a user for catalogued operator attention", () => {
  const selected = Object.entries(EVENT_CATALOG)
    .filter(([type, entry]) => shouldDispatchCockpitPushAttention(type, entry.example))
    .map(([type]) => type);

  expect(selected).toEqual([
    "execution.failed",
    "connector.oauth.callback_failed",
    "connector.auth_failed",
    "connector.health_changed",
    "patch.proposed",
    "schedule.auto_paused",
    "workflow.approval_expiring",
    "task.grant_expiring",
    "task_run.waiting",
    "task_run.result_ready",
    "task_run.failed",
  ]);
  expect(
    shouldDispatchCockpitPushAttention("connector.health_changed", {
      ...EVENT_CATALOG["connector.health_changed"].example,
      error_code: "temporary_unavailable",
    }),
  ).toBeFalse();
  expect(shouldDispatchCockpitPushAttention("unknown.event", {})).toBeFalse();
});

test("an attention event refreshes attention before the push diff runs", async () => {
  const invalidate = spyOn(attention, "invalidateAttention");
  const order: string[] = [];
  invalidate.mockImplementation(() => {
    order.push("invalidate");
  });
  try {
    await triggerCockpitPushAttention({} as Db, "tenant-a", async (_db, tenantId) => {
      order.push(`dispatch:${tenantId}`);
      return { notified: 0, delivered: 0 };
    });
    expect(order).toEqual(["invalidate", "dispatch:tenant-a"]);
  } finally {
    invalidate.mockRestore();
  }
});

test("a failed push dispatch never fails webhook fanout", async () => {
  const warn = spyOn(logger, "warn");
  try {
    await expect(
      triggerCockpitPushAttention({} as Db, "tenant-a", async () => {
        throw new Error("push dispatch unavailable");
      }),
    ).resolves.toBeUndefined();
    expect(warn.mock.calls.map((call) => (call[0] as { action?: string }).action)).toContain(
      "cockpit_push.trigger_failed",
    );
  } finally {
    warn.mockRestore();
  }
});
