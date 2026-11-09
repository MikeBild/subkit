import { describe, expect, test } from "bun:test";
import { urlSourceBody } from "./knowledge-source-request";

describe("creating a source from an address", () => {
  test("a source that is never read again sends no refresh_cron, since the contract takes a string only", () => {
    expect(urlSourceBody(" https://example.com/doc ", "never")).toEqual({
      url: "https://example.com/doc",
      refresh_strategy: "manual",
    });
  });

  test("a scheduled source sends its cron", () => {
    const body = urlSourceBody("https://example.com/doc", "weekly");
    expect(body.refresh_strategy).toBe("scheduled");
    expect(typeof body.refresh_cron).toBe("string");
  });
});
