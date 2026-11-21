import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { volumeIdOf } from "./volume-id.ts";

describe("volumeIdOf", () => {
  test("names the home volume by its UUID on macOS", async () => {
    if (process.platform !== "darwin") return;
    expect(await volumeIdOf(homedir())).toMatch(/^uuid:[0-9A-F-]{36}$/);
  });
});
