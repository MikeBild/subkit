import { describe, expect, it } from "bun:test";
import {
  isReviewDue,
  reviewDateBody,
  reviewDateInput,
  reviewDateText,
  reviewDueAt,
} from "./review-date";

describe("review date", () => {
  it("reads only a valid date from the source", () => {
    expect(reviewDueAt({ review_due_at: "2026-12-01T00:00:00.000Z" })).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(reviewDueAt({ review_due_at: "soon" })).toBeNull();
    expect(reviewDueAt({ review_due_at: null })).toBeNull();
  });

  it("fills the date input from the stored time", () => {
    expect(reviewDateInput("2026-12-01T00:00:00.000Z")).toBe("2026-12-01");
    expect(reviewDateInput(null)).toBe("");
  });

  it("sends midnight UTC for a date, null for an empty field and nothing for invalid text", () => {
    expect(reviewDateBody("2026-12-01")).toBe("2026-12-01T00:00:00.000Z");
    expect(reviewDateBody(" ")).toBeNull();
    expect(reviewDateBody("01.12.2026")).toBeUndefined();
  });

  it("is due on and after the date", () => {
    const now = new Date("2026-12-01T08:00:00.000Z");
    expect(isReviewDue("2026-12-01T00:00:00.000Z", now)).toBe(true);
    expect(isReviewDue("2026-12-02T00:00:00.000Z", now)).toBe(false);
    expect(isReviewDue(null, now)).toBe(false);
  });

  it("shows the calendar day in UTC", () => {
    expect(reviewDateText("2026-12-01T00:00:00.000Z", "en-US")).toBe("Dec 1, 2026");
  });
});
