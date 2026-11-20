import { describe, expect, test } from "bun:test";
import {
  CAPTURE_MASK_CSS,
  CAPTURE_MASKED_SELECTORS,
  fitCapture,
  reusableCapture,
} from "./capture.ts";
import { BRIDGE_CAPABILITIES } from "./ipc.ts";

describe("fitCapture", () => {
  test("keeps a capture that already fits", () => {
    expect(fitCapture({ width: 1360, height: 900 })).toEqual({ width: 1360, height: 900 });
  });

  test("scales a wide capture down and keeps its proportions", () => {
    expect(fitCapture({ width: 3200, height: 1800 })).toEqual({ width: 1600, height: 900 });
    expect(fitCapture({ width: 4000, height: 1 })).toEqual({ width: 1600, height: 1 });
  });

  test("refuses an empty capture", () => {
    expect(fitCapture({ width: 0, height: 900 })).toBeNull();
    expect(fitCapture({ width: 100, height: Number.NaN })).toBeNull();
  });
});

describe("reusableCapture", () => {
  test("hands out a fresh capture and nothing older than a minute", () => {
    expect(reusableCapture({ png: "abc", at: 1000 }, 1000 + 59_000)).toBe("abc");
    expect(reusableCapture({ png: "abc", at: 1000 }, 1000 + 61_000)).toBeNull();
    expect(reusableCapture({ png: "abc", at: 5000 }, 1000)).toBeNull();
    expect(reusableCapture(null, 1000)).toBeNull();
  });
});

test("the mask hides password and secret fields", () => {
  expect(CAPTURE_MASK_CSS).toContain('input[type="password"]');
  expect(CAPTURE_MASK_CSS).toContain("[data-sensitive]");
  expect(CAPTURE_MASK_CSS.endsWith("{visibility:hidden !important;}")).toBe(true);
});

test("the mask covers fields named after a secret, also when they show plain text", () => {
  for (const selector of [
    'input[name*="password" i]',
    'input[name*="api_key" i]',
    'input[id*="token" i]',
    'textarea[name*="secret" i]',
    'input[autocomplete*="password" i]',
    'input[autocomplete~="one-time-code"]',
    "[data-secret]",
  ])
    expect(CAPTURE_MASKED_SELECTORS).toContain(selector);
  expect(
    CAPTURE_MASKED_SELECTORS.some((selector) => /^(div|span|p|code|pre)\b/.test(selector)),
  ).toBe(false);
});

test("the bridge says that the picture is opt-in and that visible text is not hidden", () => {
  expect(BRIDGE_CAPABILITIES.screenshot).toEqual({
    optIn: true,
    masksSecretFields: true,
    masksVisibleText: false,
  });
});
