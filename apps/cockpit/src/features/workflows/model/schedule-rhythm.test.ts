import { describe, expect, test } from "bun:test";
import {
  cronToRhythm,
  editableRhythm,
  rhythmToCron,
  scheduleCronForSave,
  validTime,
} from "@/features/workflows/model/schedule-rhythm";

describe("schedule rhythm ↔ cron", () => {
  test("each rhythm writes its cron", () => {
    expect(rhythmToCron({ rhythm: "daily", weekday: 1, time: "07:05" })).toBe("5 7 * * *");
    expect(rhythmToCron({ rhythm: "weekly", weekday: 3, time: "18:30" })).toBe("30 18 * * 3");
    expect(rhythmToCron({ rhythm: "monthly", weekday: 1, time: "00:00" })).toBe("0 0 1 * *");
  });

  test("a cron the form wrote reads back as the same rhythm", () => {
    for (const value of [
      { rhythm: "daily", weekday: 1, time: "07:05" },
      { rhythm: "weekly", weekday: 0, time: "09:00" },
      { rhythm: "monthly", weekday: 1, time: "23:59" },
    ] as const)
      expect(cronToRhythm(rhythmToCron(value))).toEqual(value);
    expect(cronToRhythm("0 9 * * 7")).toEqual({ rhythm: "weekly", weekday: 0, time: "09:00" });
  });

  test("a cron the form cannot say is not bent into a rhythm", () => {
    for (const cron of ["*/5 * * * *", "0 9 * * 1-5", "0 9 15 * *", "0 9 * 1 *", "nonsense"])
      expect(cronToRhythm(cron)).toBeNull();
  });

  test("a time is HH:MM", () => {
    expect(validTime("08:00")).toBe(true);
    expect(validTime("8:00")).toBe(false);
    expect(validTime("24:00")).toBe(false);
  });
});

describe("cron sent on save", () => {
  const picked = { rhythm: "daily", weekday: 1, time: "08:00" } as const;

  test("an untouched rhythm keeps the saved cadence", () => {
    for (const existingCron of ["every:15", "every:25", "*/15 * * * *", "0 9 * * 1-5", "0 9 * * 7"])
      expect(scheduleCronForSave({ existingCron, rhythmValue: picked, rhythmTouched: false })).toBe(
        existingCron,
      );
  });

  test("a touched rhythm replaces the saved cadence", () => {
    for (const existingCron of ["every:15", "every:25", "*/15 * * * *", "0 9 * * 1-5"])
      expect(scheduleCronForSave({ existingCron, rhythmValue: picked, rhythmTouched: true })).toBe(
        "0 8 * * *",
      );
  });

  test("a new schedule takes the picked rhythm", () => {
    expect(
      scheduleCronForSave({ existingCron: null, rhythmValue: picked, rhythmTouched: false }),
    ).toBe("0 8 * * *");
  });

  test("only plain daily, weekly and monthly crons fit the picker", () => {
    expect(editableRhythm("0 8 * * *")).toBe(true);
    for (const cron of ["every:900", "*/15 * * * *", "0 9 * * 1-5"])
      expect(editableRhythm(cron)).toBe(false);
  });
});
