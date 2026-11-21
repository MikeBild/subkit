import { expect, test } from "bun:test";
import {
  SCREENSHOT_KINDS,
  SCREENSHOT_RETENTION_MS,
  screenshotExpiryAt,
} from "./screenshot-retention.ts";

test("a stored screenshot expires 30 days after it was kept, nothing else does", () => {
  expect(SCREENSHOT_RETENTION_MS).toBe(2_592_000_000);
  expect([...SCREENSHOT_KINDS]).toEqual(["browser.screenshot", "computer.screenshot"]);
  const at = Date.parse("2026-11-21T10:00:00Z");
  for (const kind of SCREENSHOT_KINDS)
    expect(screenshotExpiryAt(kind, "done", at)?.toISOString()).toBe("2026-12-21T10:00:00.000Z");
  expect(screenshotExpiryAt("browser.screenshot", "refused", at)).toBeNull();
  expect(screenshotExpiryAt("files.read_text", "done", at)).toBeNull();
});
