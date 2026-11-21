import { describe, expect, test } from "bun:test";
import {
  BrowserDownloadArgsSchema,
  BrowserExtractArgsSchema,
  BrowserFillArgsSchema,
  BrowserOpenArgsSchema,
  BrowserPageArgsSchema,
  BrowserPressArgsSchema,
  BrowserStepSchema,
  BrowserWaitArgsSchema,
} from "./browser.ts";

describe("browser command arguments", () => {
  test("open takes a URL, a partition and an optional workflow boundary", () => {
    const args = {
      url: "https://shop.example.com/",
      partition: "task-1",
      boundary: { device_id: "d1", capability: "browser" as const, sites: [] },
    };
    expect(BrowserOpenArgsSchema.parse(args)).toEqual(args);
    expect(BrowserOpenArgsSchema.safeParse({ url: "" }).success).toBe(false);
    expect(BrowserOpenArgsSchema.safeParse({ url: "x", partition: "Bad Name" }).success).toBe(
      false,
    );
    expect(BrowserOpenArgsSchema.safeParse({ url: "x", extra: 1 }).success).toBe(false);
    expect(BrowserPageArgsSchema.parse({})).toEqual({});
  });

  test("press maps click, key and scroll; refs are snapshot refs only", () => {
    expect(BrowserPressArgsSchema.parse({ action: "click", ref: "@e12" })).toEqual({
      action: "click",
      ref: "@e12",
    });
    expect(BrowserPressArgsSchema.safeParse({ action: "click", ref: "#submit" }).success).toBe(
      false,
    );
    expect(BrowserPressArgsSchema.parse({ action: "key", key: "Control+a" })).toEqual({
      action: "key",
      key: "Control+a",
    });
    expect(BrowserPressArgsSchema.safeParse({ action: "key", key: "--session x" }).success).toBe(
      false,
    );
    expect(BrowserPressArgsSchema.parse({ action: "scroll", direction: "up" })).toEqual({
      action: "scroll",
      direction: "up",
      pixels: 600,
    });
    expect(BrowserPressArgsSchema.safeParse({ action: "scroll", direction: "in" }).success).toBe(
      false,
    );
  });

  test("fill maps fill, type and select", () => {
    expect(BrowserFillArgsSchema.parse({ mode: "type", ref: "e1", text: "Ada" }).mode).toBe("type");
    expect(BrowserFillArgsSchema.parse({ mode: "select", ref: "e1", values: ["DE"] }).mode).toBe(
      "select",
    );
    expect(BrowserFillArgsSchema.safeParse({ mode: "select", ref: "e1", values: [] }).success).toBe(
      false,
    );
    expect(
      BrowserFillArgsSchema.safeParse({ mode: "fill", ref: "e1", text: "x".repeat(10_001) })
        .success,
    ).toBe(false);
  });

  test("wait is bounded, extract and download name their target", () => {
    expect(BrowserWaitArgsSchema.parse({ for: "load" })).toEqual({ for: "load", state: "load" });
    expect(BrowserWaitArgsSchema.safeParse({ for: "ms", ms: 30_001 }).success).toBe(false);
    expect(BrowserWaitArgsSchema.parse({ for: "text", text: "Done" }).for).toBe("text");
    expect(BrowserExtractArgsSchema.parse({})).toEqual({});
    expect(
      BrowserDownloadArgsSchema.parse({ ref: "e2", folder_id: "f1", name: "a.pdf" }).folder_id,
    ).toBe("f1");
    expect(BrowserDownloadArgsSchema.safeParse({ ref: "e2", name: "a.pdf" }).success).toBe(false);
  });

  test("a step carries origin, title hash, action and outcome only", () => {
    const step = {
      action: "browser.open",
      origin: "https://shop.example.com",
      title_sha256: "a".repeat(64),
      outcome: "done" as const,
    };
    expect(BrowserStepSchema.parse(step)).toEqual(step);
    expect(BrowserStepSchema.safeParse({ ...step, title: "Order 4711" }).success).toBe(false);
    expect(BrowserStepSchema.safeParse({ ...step, title_sha256: "Order" }).success).toBe(false);
  });
});
