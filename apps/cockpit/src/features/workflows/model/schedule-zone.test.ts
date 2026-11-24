import { describe, expect, test } from "bun:test";
import { scheduleZone } from "@/features/workflows/model/schedule-zone";
import { browserTimeZone } from "@/lib/timezones";

describe("schedule time zone", () => {
  test("a new schedule follows the workspace zone, not the browser zone", () => {
    expect(scheduleZone({ scheduleZone: null, workspaceZone: "America/Los_Angeles" })).toBe(
      "America/Los_Angeles",
    );
  });

  test("an existing schedule keeps its stored zone", () => {
    expect(scheduleZone({ scheduleZone: "Asia/Tokyo", workspaceZone: "America/Los_Angeles" })).toBe(
      "Asia/Tokyo",
    );
  });

  test("without a workspace zone the browser zone applies", () => {
    expect(scheduleZone({ scheduleZone: undefined, workspaceZone: null })).toBe(browserTimeZone());
  });
});
