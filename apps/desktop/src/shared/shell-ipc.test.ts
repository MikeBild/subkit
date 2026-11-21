import { describe, expect, test } from "bun:test";
import { isShellUrl, SHELL_VIEWS, shellUrl, shellViewOf } from "./shell-ipc.ts";

describe("shell page address", () => {
  test("one page, the view in the fragment", () => {
    for (const view of SHELL_VIEWS) {
      expect(isShellUrl(shellUrl(view))).toBe(true);
      expect(shellViewOf(shellUrl(view))).toBe(view);
    }
    expect(shellViewOf("subkit-app://shell/shell.html#other")).toBeNull();
    expect(isShellUrl("subkit-app://shell/index.html")).toBe(false);
    expect(isShellUrl("https://shell/shell.html")).toBe(false);
  });
});
