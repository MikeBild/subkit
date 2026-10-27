import { expect, test } from "bun:test";
import { formatWeeklyWorkflowReviewSchedule } from "./workflow-review-schedule";

test("formats a fixed weekly Monday schedule for the reader locale", () => {
  expect(formatWeeklyWorkflowReviewSchedule("0 10 * * 1", "en-US")).toBe("Monday, 10:00");
  expect(formatWeeklyWorkflowReviewSchedule("0 10 * * 1", "de-DE")).toBe("Montag, 10:00");
});

test("treats Sunday cron aliases equally", () => {
  expect(formatWeeklyWorkflowReviewSchedule("5 9 * * 0", "en-US")).toBe(
    formatWeeklyWorkflowReviewSchedule("5 9 * * 7", "en-US"),
  );
});

test("leaves non-weekly or complex cron expressions explicit", () => {
  for (const cron of ["0 10 * * 1-5", "*/15 * * * *", "0 10 1 * 1", "0 24 * * 1"]) {
    expect(formatWeeklyWorkflowReviewSchedule(cron, "en-US")).toBeNull();
  }
});
