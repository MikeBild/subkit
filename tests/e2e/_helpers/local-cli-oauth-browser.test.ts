import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  createLocalCliOAuthBrowser,
  LOCAL_CLI_OAUTH_BROWSER_SUPPORTED,
} from "./local-cli-oauth-browser.ts";

describe("local CLI OAuth browser fixture", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  test.skipIf(!LOCAL_CLI_OAUTH_BROWSER_SUPPORTED)(
    "shadows both POSIX browser launch commands without invoking either",
    () => {
      const fixture = createLocalCliOAuthBrowser({
        engineUrl: "http://127.0.0.1:3210",
        apiKey: "fixture-key",
      });
      cleanups.push(fixture.cleanup);
      const dir = fixture.env.PATH?.split(path.delimiter)[0] ?? "";

      expect(fixture.env.SUBKIT_E2E_OAUTH_ENGINE_ORIGIN).toBe("http://127.0.0.1:3210");
      expect(existsSync(path.join(dir, "open"))).toBe(true);
      expect(existsSync(path.join(dir, "xdg-open"))).toBe(true);
      expect(statSync(path.join(dir, "open")).mode & 0o111).not.toBe(0);
      expect(statSync(path.join(dir, "xdg-open")).mode & 0o111).not.toBe(0);
    },
  );

  test("refuses a non-loopback engine before creating a launcher", () => {
    expect(() =>
      createLocalCliOAuthBrowser({ engineUrl: "https://example.test", apiKey: "fixture-key" }),
    ).toThrow("loopback engine");
  });
});
