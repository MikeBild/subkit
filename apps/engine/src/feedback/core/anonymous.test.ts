import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_FEEDBACK_INSTANCE_LIMIT,
  ANONYMOUS_FEEDBACK_MAX_BODY_BYTES,
  ANONYMOUS_FEEDBACK_SOURCE_LIMIT,
  anonymousFeedbackKeys,
} from "./anonymous.ts";
import { FEEDBACK_MAX_ATTACHMENT_BYTES, FEEDBACK_MAX_SCREENSHOT_BYTES } from "./attachments.ts";

describe("anonymousFeedbackKeys", () => {
  test("counts every report per address and for the whole instance", () => {
    expect(anonymousFeedbackKeys({ ip: "203.0.113.7", device_id: null })).toEqual([
      { bucket: "ip", key: "ip:203.0.113.7" },
      { bucket: "instance", key: "instance" },
    ]);
  });

  test("adds the device when the app names one, case-insensitively", () => {
    expect(
      anonymousFeedbackKeys({
        ip: "203.0.113.7",
        device_id: "3F2C1B9A-7D4E-4C1A-9B8E-2A6F0C5D1E77",
      }),
    ).toEqual([
      { bucket: "ip", key: "ip:203.0.113.7" },
      { bucket: "device", key: "device:3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77" },
      { bucket: "instance", key: "instance" },
    ]);
  });

  test("puts requests without a known address into one shared bucket", () => {
    expect(anonymousFeedbackKeys({ ip: null, device_id: null })[0]).toEqual({
      bucket: "ip",
      key: "ip:unknown",
    });
  });
});

describe("anonymous limits", () => {
  test("allow three reports per source and sixty per instance in ten minutes", () => {
    expect(ANONYMOUS_FEEDBACK_SOURCE_LIMIT.max).toBe(3);
    expect(ANONYMOUS_FEEDBACK_SOURCE_LIMIT.windowMs).toBe(600_000);
    expect(ANONYMOUS_FEEDBACK_INSTANCE_LIMIT).toEqual({ max: 60, windowMs: 600_000 });
  });

  test("cap the whole request below the sum of the file limits", () => {
    expect(ANONYMOUS_FEEDBACK_MAX_BODY_BYTES).toBe(6 * 1024 * 1024);
    expect(ANONYMOUS_FEEDBACK_MAX_BODY_BYTES).toBeLessThan(
      FEEDBACK_MAX_SCREENSHOT_BYTES + 3 * FEEDBACK_MAX_ATTACHMENT_BYTES,
    );
  });
});
