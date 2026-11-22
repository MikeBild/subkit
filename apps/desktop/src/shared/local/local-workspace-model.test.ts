import { describe, expect, test } from "bun:test";
import {
  backupRows,
  classifyLocalFailure,
  type LocalProgress,
  localRuntime,
  megabytes,
  moveServerTarget,
  NO_PROGRESS,
  ownerName,
  parseBackupName,
  parseFinishInput,
  parseLowPowerMode,
  powerChanged,
  progressAfter,
  setupComplete,
  setupRows,
} from "./local-workspace-model.ts";
import type { SupervisorPhase } from "./supervisor-model.ts";

const run = (phases: SupervisorPhase[], start: LocalProgress = NO_PROGRESS) =>
  phases.reduce(progressAfter, start);

describe("setup progress follows the supervisor", () => {
  test("the database is done once it accepts connections, the engine once it runs", () => {
    expect(run(["preparing", "starting_database"])).toEqual(NO_PROGRESS);
    expect(run(["preparing", "starting_database", "starting_engine"])).toEqual({
      database: true,
      engine: false,
      workspace: false,
    });
    expect(run(["preparing", "starting_database", "backing_up"]).database).toBe(true);
    expect(run(["preparing", "starting_database", "starting_engine", "running"])).toEqual({
      database: true,
      engine: true,
      workspace: false,
    });
  });

  test("a failure keeps what was reached, a restart begins again but keeps the workspace", () => {
    const reached = run(["starting_engine", "running"]);
    expect(run(["failed"], reached)).toEqual(reached);
    expect(run(["restarting"], { ...reached, workspace: true })).toEqual({
      ...NO_PROGRESS,
      workspace: true,
    });
    const signedIn = { ...reached, workspace: true };
    expect(progressAfter(signedIn, "preparing")).toEqual({ ...NO_PROGRESS, workspace: true });
  });

  test("rows show done phases and one active phase only while work goes on", () => {
    const progress = { database: true, engine: false, workspace: false };
    expect(setupRows(progress, true).map((row) => row.state)).toEqual([
      "done",
      "active",
      "pending",
    ]);
    expect(setupRows(progress, false).map((row) => row.state)).toEqual([
      "done",
      "pending",
      "pending",
    ]);
    expect(setupRows(NO_PROGRESS, true).map((row) => row.phase)).toEqual([
      "database",
      "engine",
      "workspace",
    ]);
    const all = { database: true, engine: true, workspace: true };
    expect(setupRows(all, true).every((row) => row.state === "done")).toBe(true);
    expect(setupComplete(all)).toBe(true);
    expect(setupComplete(progress)).toBe(false);
  });
});

describe("failures get a remedy", () => {
  test("port in use, disk full, permission and folder are told apart", () => {
    expect(classifyLocalFailure("listen EADDRINUSE: address already in use 127.0.0.1:47811")).toBe(
      "port",
    );
    expect(
      classifyLocalFailure("initdb failed: could not extend file: No space left on device"),
    ).toBe("disk");
    expect(classifyLocalFailure("EACCES: permission denied, mkdir '/x'")).toBe("permission");
    expect(classifyLocalFailure("EROFS: read-only file system")).toBe("permission");
    expect(classifyLocalFailure("cloud_synced_folder")).toBe("folder");
    expect(classifyLocalFailure("network_folder")).toBe("folder");
    expect(classifyLocalFailure("the engine did not become healthy in time")).toBe("failed");
    expect(classifyLocalFailure("PostgreSQL ended while starting; see postgres.log")).toBe(
      "database",
    );
    expect(classifyLocalFailure("downgrade_refused")).toBe("version");
  });
});

describe("the owner", () => {
  test("has a name without control characters", () => {
    expect(ownerName("  Mike Bild ")).toBe("Mike Bild");
    expect(ownerName("   ")).toBeNull();
    expect(ownerName("Mike\u0007")).toBeNull();
    expect(ownerName("x".repeat(121))).toBeNull();
  });
});

describe("the setup input main accepts from the window", () => {
  test("a name with a provider key or a loopback model server, nothing else", () => {
    expect(
      parseFinishInput({
        name: " Anna ",
        ai: { kind: "provider", provider: "openai", key: " k " },
      }),
    ).toEqual({ name: "Anna", ai: { kind: "provider", provider: "openai", key: "k" } });
    expect(
      parseFinishInput({ name: "Anna", ai: { kind: "model", origin: "http://localhost:11434/" } }),
    ).toEqual({ name: "Anna", ai: { kind: "model", origin: "http://localhost:11434" } });
    for (const refused of [
      null,
      "x",
      { name: "", ai: { kind: "provider", provider: "openai", key: "k" } },
      { name: "Anna" },
      { name: "Anna", ai: { kind: "provider", provider: "mock", key: "k" } },
      { name: "Anna", ai: { kind: "provider", provider: "openai", key: " " } },
      { name: "Anna", ai: { kind: "provider", provider: "openai", key: "k".repeat(4097) } },
      { name: "Anna", ai: { kind: "model", origin: "http://10.0.0.2:11434" } },
      { name: "Anna", ai: { kind: "model" } },
      { name: "Anna", ai: { kind: "other" } },
    ])
      expect(parseFinishInput(refused)).toBeNull();
  });
});

describe("backups", () => {
  test("names carry their time and reason", () => {
    expect(parseBackupName("2026-11-21T08-49-51Z-manual")).toEqual({
      name: "2026-11-21T08-49-51Z-manual",
      at: Date.parse("2026-11-21T08:49:51Z"),
      reason: "manual",
      automatic: false,
    });
    expect(parseBackupName("2026-11-21T08-49-51Z-update")?.automatic).toBe(true);
    expect(parseBackupName("2026-11-21T08-49-51Z-restore")?.automatic).toBe(true);
    expect(parseBackupName("2026-13-45T08-49-51Z-manual")).toBeNull();
    expect(parseBackupName("../etc")).toBeNull();
    expect(parseBackupName("2026-11-21T08-49-51Z-other")).toBeNull();
  });

  test("the list is newest first and skips foreign folders", () => {
    const rows = backupRows([
      { name: "2026-11-20T08-00-00Z-update", sizeBytes: 2_000_000 },
      { name: ".DS_Store", sizeBytes: 1 },
      { name: "2026-11-21T08-00-00Z-manual", sizeBytes: null },
    ]);
    expect(rows.map((row) => row.name)).toEqual([
      "2026-11-21T08-00-00Z-manual",
      "2026-11-20T08-00-00Z-update",
    ]);
    expect(rows[1]?.sizeBytes).toBe(2_000_000);
  });

  test("sizes read in whole megabytes", () => {
    expect(megabytes(null)).toBeNull();
    expect(megabytes(-1)).toBeNull();
    expect(megabytes(0)).toBe(0);
    expect(megabytes(1)).toBe(1);
    expect(megabytes(24_400_000)).toBe(24);
  });
});

describe("power", () => {
  test("reads low power mode from pmset", () => {
    expect(parseLowPowerMode(" lowpowermode         1\n powernap 1")).toBe(true);
    expect(parseLowPowerMode(" lowpowermode         0\n")).toBe(false);
    expect(parseLowPowerMode("")).toBe(false);
  });

  test("reports only a change", () => {
    const battery = { on_battery: true, low_power_mode: false };
    expect(powerChanged(null, battery)).toBe(true);
    expect(powerChanged(battery, { ...battery })).toBe(false);
    expect(powerChanged(battery, { ...battery, low_power_mode: true })).toBe(true);
    expect(powerChanged(battery, { ...battery, on_battery: false })).toBe(true);
  });
});

describe("the local runtime", () => {
  const base = {
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    resourcesPath: "/Applications/SubKit.app/Contents/Resources",
    repo: "/repo",
  };

  test("a packaged app runs its bundled engine and PostgreSQL", () => {
    expect(localRuntime({ ...base, exists: () => true })).toEqual({
      postgresDir: "/Applications/SubKit.app/Contents/Resources/local/postgres",
      engineCommand: ["/Applications/SubKit.app/Contents/Resources/local/engine"],
    });
  });

  test("a development start uses the compiled engine or the engine source", () => {
    const dev = { ...base, packaged: false };
    expect(localRuntime({ ...dev, exists: () => true })?.engineCommand).toEqual([
      "/repo/dist/engine-desktop/mac/arm64/engine",
    ]);
    expect(
      localRuntime({ ...dev, exists: (path) => !path.includes("engine-desktop") })?.engineCommand,
    ).toEqual(["bun", "/repo/apps/engine/src/index.ts"]);
  });

  test("other platforms and a missing bundle offer no local mode", () => {
    expect(localRuntime({ ...base, arch: "x64", exists: () => true })).toBeNull();
    expect(localRuntime({ ...base, platform: "win32", exists: () => true })).toBeNull();
    expect(localRuntime({ ...base, exists: (path) => !path.endsWith("postgres") })).toBeNull();
    expect(localRuntime({ ...base, exists: (path) => !path.endsWith("engine") })).toBeNull();
  });

  test("a development start finds PostgreSQL next to the desktop app", () => {
    const seen: string[] = [];
    const runtime = localRuntime({
      ...base,
      packaged: false,
      exists: (path) => {
        seen.push(path);
        return true;
      },
    });
    expect(runtime?.postgresDir).toBe("/repo/apps/desktop/resources/postgres/darwin-arm64");
    expect(seen).toContain("/repo/apps/desktop/resources/postgres/darwin-arm64/bin/postgres");
  });
});

describe("edges", () => {
  test("nothing is reached at first, and a running engine implies its database", () => {
    expect(NO_PROGRESS).toEqual({ database: false, engine: false, workspace: false });
    expect(progressAfter(NO_PROGRESS, "running")).toEqual({
      database: true,
      engine: true,
      workspace: false,
    });
    expect(progressAfter(NO_PROGRESS, "backing_up").database).toBe(true);
    expect(progressAfter(NO_PROGRESS, "starting_database").database).toBe(false);
  });

  test("a busy port is recognized in its own words", () => {
    expect(classifyLocalFailure("port 47811 is in use")).toBe("port");
    expect(classifyLocalFailure("port 47811 is taken")).toBe("port");
    expect(classifyLocalFailure("port x is taken")).toBe("failed");
  });

  test("a name may be as long as the limit, a key as long as its limit", () => {
    expect(ownerName("x".repeat(120))).toBe("x".repeat(120));
    const ai = { kind: "provider", provider: "gemini", key: "k".repeat(4096) } as const;
    expect(parseFinishInput({ name: "Anna", ai })?.ai).toEqual(ai);
    expect(
      parseFinishInput({ name: "Anna", ai: { kind: "provider", provider: "anthropic", key: "k" } })
        ?.ai,
    ).toMatchObject({ provider: "anthropic" });
  });

  test("main refuses input of the wrong shape", () => {
    for (const refused of [
      { ai: { kind: "model", origin: "http://localhost:1" } },
      { name: "Anna", ai: { kind: "provider", provider: "openai", key: 5 } },
      { name: "Anna", ai: { kind: "other", origin: "http://localhost:1" } },
      { name: "Anna", ai: { kind: "model", origin: 5 } },
      { name: "Anna", ai: "model" },
      undefined,
    ])
      expect(parseFinishInput(refused)).toBeNull();
  });

  test("backup names match whole", () => {
    expect(parseBackupName("x2026-11-21T08-49-51Z-manual")).toBeNull();
    expect(parseBackupName("2026-11-21T08-49-51Z-manualx")).toBeNull();
  });

  test("low power mode is read from its own line only", () => {
    expect(parseLowPowerMode("  lowpowermode 1")).toBe(true);
    expect(parseLowPowerMode("lowpowermode 1  ")).toBe(true);
    expect(parseLowPowerMode(" xlowpowermode 1")).toBe(false);
    expect(parseLowPowerMode(" lowpowermode 10")).toBe(false);
    expect(parseLowPowerMode(" lowpowermode 1x")).toBe(false);
  });
});

describe("later AI and the move target", () => {
  test("main accepts a setup without AI only when it is said explicitly", () => {
    expect(parseFinishInput({ name: "Anna", ai: null })).toEqual({ name: "Anna", ai: null });
    expect(parseFinishInput({ name: "Anna" })).toBeNull();
  });

  test("the move goes to an https server or one on loopback", () => {
    expect(moveServerTarget("subkit.example.com")).toBe("https://subkit.example.com");
    expect(moveServerTarget("localhost:3000")).toBe("http://localhost:3000");
    expect(moveServerTarget("http://subkit.example.com")).toBeNull();
    expect(moveServerTarget(5)).toBeNull();
  });
});
