import { describe, expect, test } from "bun:test";
import {
  projectForViewer,
  streamDeliveryReader,
  viewerDeliveryState,
} from "../http/routes/cockpit-events.ts";
import type { PushPreference } from "../identity/setup-preferences.ts";
import {
  deliverableNow,
  deliveryOf,
  PERSONAL_SCHEDULE_CHANNELS,
  personalScheduleApplies,
  type StreamDeliveryHint,
  streamDeliveryHint,
} from "./personal-schedule.ts";

const at = (iso: string) => new Date(iso);

function preference(overrides: Partial<PushPreference> = {}): PushPreference {
  return {
    schedule: { mode: "working_hours", from: "09:00", to: "17:00" },
    timezone: "Europe/Berlin",
    critical_breakthrough: false,
    last_digest_at: null,
    approver_user_id: null,
    ...overrides,
  };
}

const stoppedLive = {
  class: "stopped",
  reason: "schedule_auto_paused",
  subject: { kind: "workflow", environment: "prod" as const },
};
const stoppedTest = {
  class: "stopped",
  reason: "schedule_auto_paused",
  subject: { kind: "workflow", environment: "dev" as const },
};
const failing = { class: "failing", reason: "failing", subject: { kind: "workflow" } };

describe("which channels follow the personal schedule", () => {
  test("what is addressed to a person follows it, shared and machine channels do not", () => {
    expect(personalScheduleApplies("cockpit_push")).toBe(true);
    expect(personalScheduleApplies("cockpit_stream")).toBe(true);
    expect(personalScheduleApplies("cli_inbox")).toBe(false);
    expect(personalScheduleApplies("chat_channel")).toBe(false);
    expect(personalScheduleApplies("outbound_webhook")).toBe(false);
    expect(Object.keys(PERSONAL_SCHEDULE_CHANNELS).sort()).toEqual([
      "chat_channel",
      "cli_inbox",
      "cockpit_push",
      "cockpit_stream",
      "outbound_webhook",
    ]);
  });
});

describe("the delivery verdict of one person", () => {
  test("inside the window everything is delivered, outside it waits for the next start", () => {
    const open = deliveryOf(preference(), at("2026-11-20T10:00:00Z"));
    expect(open).toMatchObject({ held: false, digest: false, next_delivery: null });
    expect(deliverableNow(open, [failing, stoppedLive])).toEqual([failing, stoppedLive]);
    expect(streamDeliveryHint(open)).toBeNull();

    const weekend = deliveryOf(preference(), at("2026-11-21T10:00:00Z"));
    expect(weekend.held).toBe(true);
    expect(weekend.next_delivery?.toISOString()).toBe("2026-11-23T08:00:00.000Z");
    expect(deliverableNow(weekend, [failing, stoppedLive])).toEqual([]);
    expect(streamDeliveryHint(weekend)).toBe("held");
  });

  test("a person who opted in is reached by critical items only", () => {
    const onCall = deliveryOf(
      preference({ critical_breakthrough: true }),
      at("2026-11-21T10:00:00Z"),
    );
    expect(deliverableNow(onCall, [failing, stoppedLive, stoppedTest])).toEqual([stoppedLive]);
    expect(streamDeliveryHint(onCall)).toBe("critical_only");
  });

  test("the daily summary is due once after its time", () => {
    const digest = { mode: "daily_digest" as const, at: "09:00" };
    const due = deliveryOf(
      preference({ schedule: digest, last_digest_at: at("2026-11-19T08:00:00Z") }),
      at("2026-11-20T08:00:00Z"),
    );
    expect(due).toMatchObject({ held: false, digest: true });
    const done = deliveryOf(
      preference({ schedule: digest, last_digest_at: at("2026-11-20T08:00:00Z") }),
      at("2026-11-20T09:00:00Z"),
    );
    expect(done.held).toBe(true);
    expect(done.next_delivery?.toISOString()).toBe("2026-11-21T08:00:00.000Z");
  });
});

describe("the announcement hint on the Cockpit event stream", () => {
  const hintOf = (value: StreamDeliveryHint) => async () => value;
  const connector = "c0ffee00-0000-4000-8000-000000000001";

  test("a frame that touches attention carries the hint while the person is not to be disturbed", async () => {
    const row = { type: "connector.auth_failed", payload: { connector_id: connector } };
    expect(await projectForViewer(row, hintOf("held"))).toEqual({
      connector_id: connector,
      attention_id: `connector:${connector}`,
      delivery: "held",
    });
    expect(await projectForViewer(row, hintOf("critical_only"))).toMatchObject({
      delivery: "critical_only",
    });
    expect(await projectForViewer(row, hintOf(null))).toEqual({
      connector_id: connector,
      attention_id: `connector:${connector}`,
    });
  });

  test("progress frames never carry it and do not ask for the schedule", async () => {
    let asked = 0;
    const counting = async () => {
      asked += 1;
      return "held" as const;
    };
    expect(await projectForViewer({ type: "execution.started", payload: {} }, counting)).toEqual(
      {},
    );
    expect(asked).toBe(0);
  });

  test("the hello and heartbeat frames carry the current verdict, and nothing while notifications are due", async () => {
    expect(await viewerDeliveryState(hintOf("held"))).toEqual({ delivery: "held" });
    expect(await viewerDeliveryState(hintOf("critical_only"))).toEqual({
      delivery: "critical_only",
    });
    expect(await viewerDeliveryState(hintOf(null))).toEqual({});
  });

  test("the verdict is read again after half a minute and a failed read hides nothing", async () => {
    let time = 1_000_000;
    let reads = 0;
    const reader = streamDeliveryReader(
      async () => {
        reads += 1;
        if (reads === 2) throw new Error("database unavailable");
        return "held";
      },
      () => time,
    );
    expect(await reader()).toBe("held");
    expect(await reader()).toBe("held");
    expect(reads).toBe(1);
    time += 30_000;
    expect(await reader()).toBeNull();
    time += 30_000;
    expect(await reader()).toBe("held");
    expect(reads).toBe(3);
  });
});
