import { describe, expect, test } from "bun:test";
import type { Setup } from "@/api/setup";
import { answersFromSetup } from "@/features/setup";
import {
  approvalsTo,
  notificationChange,
  notificationView,
  quietNow,
  terminalQuietError,
} from "./notifications-model";

const base = {
  default_chat_mode: "auto",
  default_environment: "dev",
  approver: { kind: "self" },
  notifications: { mode: "immediately" },
  timezone: null,
  critical_breakthrough: false,
  first_job: null,
  services: [],
  unset: [],
} as unknown as Setup;

const answers = (notifications: Setup["notifications"], timezone: string | null = "UTC") =>
  answersFromSetup({ ...base, notifications, timezone });

describe("notifications show one concept: quiet hours", () => {
  test("working hours 08:00–18:00 read as quiet hours 18:00–08:00", () => {
    const view = notificationView(
      answers({ mode: "working_hours", from: "08:00", to: "18:00", days: [1, 2, 3, 4, 5] }),
    );
    expect(view).toMatchObject({
      quiet: true,
      quietFrom: "18:00",
      quietUntil: "08:00",
      digest: false,
    });
  });

  test("right away has no quiet hours and no summary", () => {
    expect(notificationView(answers({ mode: "immediately" }))).toMatchObject({
      quiet: false,
      digest: false,
      scheduled: false,
    });
  });

  test("the daily summary is its own switch with its time", () => {
    expect(notificationView(answers({ mode: "daily_digest", at: "17:00" }))).toMatchObject({
      quiet: false,
      digest: true,
      digestAt: "17:00",
    });
  });

  test("switching quiet hours on stores working hours, inverted", () => {
    const edit = notificationChange(answers({ mode: "immediately" }), { quiet: true });
    expect(edit.update?.notifications).toEqual({
      mode: "working_hours",
      from: "08:00",
      to: "18:00",
      days: [1, 2, 3, 4, 5],
    });
  });

  test("moving the quiet start moves the end of the working day", () => {
    const start = answers({ mode: "working_hours", from: "08:00", to: "18:00", days: [1, 2] });
    const edit = notificationChange(start, { quietFrom: "20:00" });
    expect(edit.update?.notifications).toEqual({
      mode: "working_hours",
      from: "08:00",
      to: "20:00",
      days: [1, 2],
    });
  });

  test("a round trip keeps a window across midnight", () => {
    const night = answers({ mode: "working_hours", from: "22:00", to: "06:00", days: [5] });
    const view = notificationView(night);
    expect(view).toMatchObject({ quietFrom: "06:00", quietUntil: "22:00" });
    const edit = notificationChange(night, {
      quietFrom: view.quietFrom,
      quietUntil: view.quietUntil,
    });
    expect(edit.update?.notifications).toEqual({
      mode: "working_hours",
      from: "22:00",
      to: "06:00",
      days: [5],
    });
  });

  test("quiet hours and the summary exclude each other", () => {
    const quiet = answers({ mode: "working_hours", from: "08:00", to: "18:00", days: [1] });
    expect(notificationChange(quiet, { digest: true }).update?.notifications).toEqual({
      mode: "daily_digest",
      at: "08:00",
    });
    expect(notificationChange(quiet, { quiet: false }).update?.notifications).toEqual({
      mode: "immediately",
    });
  });

  test("a schedule without its own time zone keeps the workspace zone", () => {
    const edit = notificationChange(answers({ mode: "immediately" }, null), { digest: true });
    expect(edit.update?.timezone).toBeNull();
  });

  test("no day left saves nothing and names the error", () => {
    const quiet = answers({ mode: "working_hours", from: "08:00", to: "18:00", days: [1] });
    const edit = notificationChange(quiet, { days: [] });
    expect(edit.update).toBeNull();
    expect(edit.error).toBe("setup.daysError");
  });
});

describe("quiet right now", () => {
  const view = notificationView(
    answers({ mode: "working_hours", from: "08:00", to: "18:00", days: [1, 2, 3, 4, 5] }),
  );
  test("inside working hours on a working day it is not quiet", () => {
    expect(quietNow(view, new Date("2026-11-23T10:00:00Z"), "UTC")).toBe(false);
  });
  test("in the evening and on the weekend it is quiet", () => {
    expect(quietNow(view, new Date("2026-11-23T19:00:00Z"), "UTC")).toBe(true);
    expect(quietNow(view, new Date("2026-11-22T10:00:00Z"), "UTC")).toBe(true);
  });
  test("a window across midnight belongs to the day it starts on", () => {
    const night = notificationView(
      answers({ mode: "working_hours", from: "22:00", to: "06:00", days: [5] }),
    );
    expect(quietNow(night, new Date("2026-11-27T23:00:00Z"), "UTC")).toBe(false);
    expect(quietNow(night, new Date("2026-11-28T03:00:00Z"), "UTC")).toBe(false);
    expect(quietNow(night, new Date("2026-11-28T23:00:00Z"), "UTC")).toBe(true);
  });
  test("without quiet hours it is never quiet", () => {
    expect(
      quietNow(
        notificationView(answers({ mode: "immediately" })),
        new Date("2026-11-28T03:00:00Z"),
        "UTC",
      ),
    ).toBe(false);
  });
});

describe("terminal quiet hours and approvals", () => {
  test("both times or none", () => {
    expect(terminalQuietError({ from: "", until: "" })).toBeNull();
    expect(terminalQuietError({ from: "22:00", until: "07:00" })).toBeNull();
    expect(terminalQuietError({ from: "22:00", until: "" })).toBe("setup.timeError");
  });
  test("approval notifications go to the named teammate, otherwise to you", () => {
    const anna = { kind: "teammate", email: "anna@example.com" };
    expect(approvalsTo({ ...anna, invitation: "member", can_approve: true }, "Mike")).toBe(
      "anna@example.com",
    );
    expect(approvalsTo({ ...anna, invitation: "pending" }, "Mike")).toBe("Mike");
    expect(approvalsTo({ ...anna, invitation: "needs_admin" }, "Mike")).toBe("Mike");
    expect(approvalsTo({ ...anna, invitation: "member", can_approve: false }, "Mike")).toBe("Mike");
    expect(approvalsTo({ kind: "self" }, "Mike")).toBe("Mike");
    expect(
      approvalsTo({ ...anna, kind: "pair", invitation: "member", can_approve: true }, "Mike"),
    ).toBe("Mike");
  });
});
