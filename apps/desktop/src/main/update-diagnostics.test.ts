import { describe, expect, test } from "bun:test";
import type { LogValue } from "../shared/app-log.ts";
import {
  bundlePathOf,
  type DiagnosticsEnv,
  type DiagnosticsIo,
  logVolumes,
  markerPath,
  parseMarker,
  plistSummary,
  recordInstallAttempt,
  reportPreviousUpdate,
  shipItCacheDir,
  tailOf,
  volumeReport,
} from "./update-diagnostics.ts";

type Entry = { level: "info" | "warn"; event: string; fields: Record<string, LogValue> };

const SHIPIT = "/Users/qa/Library/Caches/dev.mikebild.subkit.desktop.ShipIt";

function fakeLog() {
  const entries: Entry[] = [];
  return {
    entries,
    info: (event: string, fields: Record<string, LogValue> = {}) =>
      entries.push({ level: "info", event, fields }),
    warn: (event: string, fields: Record<string, LogValue> = {}) =>
      entries.push({ level: "warn", event, fields }),
  };
}

function fakeIo(
  files: Record<string, string> = {},
  devices: Record<string, number> = {},
  free: Record<string, number> = {},
) {
  const store = new Map(Object.entries(files));
  const io: DiagnosticsIo = {
    device: (path) => devices[path] ?? null,
    freeBytes: (path) => free[path] ?? null,
    readText: (path) => store.get(path) ?? null,
    writeText: (path, text) => {
      store.set(path, text);
    },
    remove: (path) => {
      store.delete(path);
    },
  };
  return { io, store };
}

const env = (overrides: Partial<DiagnosticsEnv> = {}): DiagnosticsEnv => ({
  execPath: "/Applications/SubKit.app/Contents/MacOS/SubKit",
  tmpDir: "/var/folders/xy/T",
  homeDir: "/Users/qa",
  userDataDir: "/Users/qa/Library/Application Support/SubKit",
  bundleId: "dev.mikebild.subkit.desktop",
  platform: "darwin",
  version: "13.0.2",
  ...overrides,
});

describe("paths of the self-update", () => {
  test("finds the app bundle above the executable", () => {
    expect(bundlePathOf("/Applications/SubKit.app/Contents/MacOS/SubKit")).toBe(
      "/Applications/SubKit.app",
    );
    expect(bundlePathOf("/usr/local/bin/bun")).toBeNull();
  });

  test("names the ShipIt cache and the marker", () => {
    expect(shipItCacheDir("/Users/qa", "dev.mikebild.subkit.desktop")).toBe(SHIPIT);
    expect(markerPath("/data")).toBe("/data/update-pending.json");
  });
});

describe("volume report", () => {
  test("flags a bundle on another volume than the temp folder", () => {
    const { io } = fakeIo(
      {},
      { "/Applications/SubKit.app": 1, "/var/folders/xy/T": 2 },
      { "/Applications/SubKit.app": 500, "/var/folders/xy/T": 900 },
    );
    expect(volumeReport(env(), io)).toEqual({
      bundle: "/Applications/SubKit.app",
      bundle_dev: 1,
      tmp_dir: "/var/folders/xy/T",
      tmp_dev: 2,
      cross_volume: true,
      bundle_free_bytes: 500,
      tmp_free_bytes: 900,
    });
  });

  test("logs a warning only when the volumes differ", () => {
    const log = fakeLog();
    const same = fakeIo({}, { "/Applications/SubKit.app": 1, "/var/folders/xy/T": 1 }).io;
    const split = fakeIo({}, { "/Applications/SubKit.app": 1, "/var/folders/xy/T": 3 }).io;
    logVolumes("downloaded", "13.0.2", env(), same, log);
    logVolumes("downloaded", "13.0.2", env(), split, log);
    expect(
      log.entries.map((entry) => [entry.level, entry.event, entry.fields.cross_volume]),
    ).toEqual([
      ["info", "update.volumes", false],
      ["warn", "update.volumes", true],
    ]);
  });

  test("leaves the comparison open when a device is unknown", () => {
    expect(volumeReport(env({ execPath: "/usr/bin/x" }), fakeIo().io).cross_volume).toBeNull();
  });
});

describe("marker across the restart", () => {
  test("records the expected version before the install", () => {
    const log = fakeLog();
    const { io, store } = fakeIo();
    recordInstallAttempt("13.0.2", env({ version: "12.1.6" }), io, log);
    expect(parseMarker(store.get(markerPath(env().userDataDir)) ?? null)).toEqual({
      expected: "13.0.2",
      from: "12.1.6",
    });
    expect(log.entries.map((entry) => entry.event)).toEqual(["update.volumes", "update.marker"]);
    expect(log.entries[0]?.fields.stage).toBe("before_install");
  });

  test("ignores a broken or missing marker", () => {
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker("{")).toBeNull();
    expect(parseMarker('{"expected":1}')).toBeNull();
  });

  test("does nothing on a launch without an update attempt", () => {
    const log = fakeLog();
    expect(reportPreviousUpdate(env(), fakeIo().io, log)).toBeNull();
    expect(log.entries).toEqual([]);
  });

  test("reports a successful update once and removes the marker", () => {
    const log = fakeLog();
    const path = markerPath(env().userDataDir);
    const { io, store } = fakeIo(
      { [path]: JSON.stringify({ expected: "13.0.2", from: "12.1.6" }) },
      { "/Applications/SubKit.app": 1 },
    );
    reportPreviousUpdate(env(), io, log);
    expect(store.has(path)).toBe(false);
    expect(log.entries[0]).toEqual({
      level: "info",
      event: "update.result",
      fields: {
        expected: "13.0.2",
        from: "12.1.6",
        actual: "13.0.2",
        matched: true,
        bundle: "/Applications/SubKit.app",
        bundle_present: true,
      },
    });
    expect(reportPreviousUpdate(env(), io, fakeLog())).toBeNull();
  });

  test("warns when the old version still runs and attaches the ShipIt evidence", () => {
    const log = fakeLog();
    const stderr = Array.from({ length: 45 }, (_, index) => `line ${index + 1}`).join("\n");
    const state =
      "<plist><dict><key>targetBundleURL</key><string>file:///Applications/SubKit.app/</string>" +
      "<key>launchAfterInstallation</key><true/></dict></plist>";
    const { io } = fakeIo(
      {
        [markerPath(env().userDataDir)]: JSON.stringify({ expected: "13.0.2", from: "12.1.6" }),
        [`${SHIPIT}/ShipIt_stderr.log`]: stderr,
        [`${SHIPIT}/ShipItState.plist`]: state,
      },
      { [SHIPIT]: 1 },
    );
    reportPreviousUpdate(env({ version: "12.1.6" }), io, log);
    const [result, shipit, shipState, ...lines] = log.entries;
    expect(result?.level).toBe("warn");
    expect(result?.fields).toMatchObject({ matched: false, bundle_present: false });
    expect(shipit).toMatchObject({
      event: "update.shipit",
      fields: { dir: SHIPIT, present: true, stderr_present: true, state_present: true },
    });
    expect(shipState?.fields).toEqual({
      format: "xml",
      entries: "targetBundleURL=file:///Applications/SubKit.app/ | launchAfterInstallation=true",
    });
    expect(lines).toHaveLength(40);
    expect(lines[0]?.fields).toEqual({ line_no: 1, of: 40, line: "line 6" });
    expect(lines.at(-1)?.fields.line).toBe("line 45");
  });

  test("skips ShipIt outside macOS", () => {
    const log = fakeLog();
    const { io } = fakeIo({
      [markerPath(env().userDataDir)]: JSON.stringify({ expected: "13.0.2", from: "12.1.6" }),
    });
    reportPreviousUpdate(env({ platform: "win32", execPath: "C:\\SubKit\\SubKit.exe" }), io, log);
    expect(log.entries.map((entry) => entry.event)).toEqual(["update.result"]);
    expect(log.entries[0]?.fields.bundle_present).toBeNull();
  });
});

describe("text helpers", () => {
  test("keeps the last non-empty lines", () => {
    expect(tailOf("a\n\nb\r\nc\n", 2)).toEqual(["b", "c"]);
  });

  test("reads the printable strings of a binary plist", () => {
    expect(plistSummary("bplist00\u0001\u0002targetBundleURL\u0003file:///A.app\u0000ok")).toEqual({
      format: "binary",
      entries: ["targetBundleURL", "file:///A.app"],
    });
  });
});
