import { describe, expect, test } from "bun:test";
import { startUpdateNotifier, type UpdateNotifierOptions } from "../update-notifier.ts";
import { writeCache } from "../updater.ts";
import { makeConfig, makeFetchImpl, TEST_NOW_MS, useUpdaterTmpDir } from "./updater-fixtures.ts";

useUpdaterTmpDir();

function harness(overrides: Partial<UpdateNotifierOptions> = {}, latestTag = "v99.0.0") {
  const written: string[] = [];
  const exits: Array<() => void> = [];
  const seen: string[] = [];
  const options: UpdateNotifierOptions = {
    command: "workflows",
    machineReadable: false,
    enabledInSettings: true,
    config: makeConfig({ currentVersion: "12.1.0" }),
    fetchImpl: makeFetchImpl((url) => {
      seen.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: `https://github.test/o/r/releases/tag/${latestTag}` },
      });
    }),
    sink: { isTTY: true, write: (text) => written.push(text) },
    onExit: (listener) => exits.push(listener),
    now: TEST_NOW_MS,
    ...overrides,
  };
  return {
    options,
    written,
    seen,
    exit: () => {
      for (const listener of exits) listener();
    },
  };
}

describe("startUpdateNotifier", () => {
  test("prints one hint line at exit when a newer release exists", async () => {
    const h = harness();
    await startUpdateNotifier(h.options);
    h.exit();
    expect(h.written).toEqual([
      "subkit 99.0.0 is available (you have 12.1.0). Run `subkit update` to install it.\n",
    ]);
  });

  test("stays quiet when the installed version is the latest", async () => {
    const h = harness({}, "v12.1.0");
    await startUpdateNotifier(h.options);
    h.exit();
    expect(h.written).toEqual([]);
  });

  test("uses the daily cache instead of the network", async () => {
    const config = makeConfig({ currentVersion: "12.1.0" });
    writeCache(config.cacheDir, {
      last_check: TEST_NOW_MS - 1000,
      latest_version: "12.2.0",
      latest_tag: "v12.2.0",
      current_version_at_check: "12.1.0",
    });
    const h = harness({ config });
    await startUpdateNotifier(h.options);
    h.exit();
    expect(h.seen).toEqual([]);
    expect(h.written.join("")).toContain("subkit 12.2.0 is available");
  });

  test("does not check at all when switched off in the settings", () => {
    const h = harness({ enabledInSettings: false });
    expect(startUpdateNotifier(h.options)).toBeNull();
    h.exit();
    expect(h.seen).toEqual([]);
    expect(h.written).toEqual([]);
  });

  test("swallows network failures", async () => {
    const h = harness({
      fetchImpl: makeFetchImpl(() => {
        throw new Error("offline");
      }),
    });
    await startUpdateNotifier(h.options);
    h.exit();
    expect(h.written).toEqual([]);
  });
});
