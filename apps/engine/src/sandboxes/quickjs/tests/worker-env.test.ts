import { describe, expect, test } from "bun:test";
import { workerEnv } from "../runtime.ts";

const vars: Record<string, string> = { PATH: "/usr/bin", SYSTEMROOT: "C:\\Windows" };
const read = (name: string): string | undefined => vars[name];

describe("sandbox worker environment", () => {
  test("passes only PATH and NODE_ENV outside Windows", () => {
    expect(workerEnv("darwin", read)).toEqual({ PATH: "/usr/bin", NODE_ENV: "production" });
  });

  test("keeps SYSTEMROOT on Windows so the worker can start", () => {
    expect(workerEnv("win32", read)).toEqual({
      PATH: "/usr/bin",
      NODE_ENV: "production",
      SYSTEMROOT: "C:\\Windows",
    });
  });

  test("leaves SYSTEMROOT out on Windows when it is not set", () => {
    expect(workerEnv("win32", () => undefined)).toEqual({ PATH: "", NODE_ENV: "production" });
  });
});
