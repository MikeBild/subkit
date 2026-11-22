import { describe, expect, test } from "bun:test";
import {
  backupName,
  backupsToPrune,
  compareVersions,
  databaseUrl,
  dataFolderRefusal,
  INITIAL_SUPERVISOR_STATE,
  laptopPostgresSettings,
  localLayout,
  nextSupervisorState,
  parseEngineReady,
  parseMountTable,
  type SupervisorEvent,
  type SupervisorState,
  socketDirectoryFor,
  upgradePlan,
} from "./supervisor-model.ts";

const MOUNTS = parseMountTable(
  [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
    "//mike@nas.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by mike)",
    "nas:/export on /Volumes/nfs data (nfs)",
  ].join("\n"),
);
const MAC = { platform: "darwin", home: "/Users/mike", mounts: MOUNTS };
const WIN = { platform: "win32", home: "C:\\Users\\Mike", mounts: [] };

describe("layout", () => {
  test("keeps everything of a workspace in one folder", () => {
    expect(localLayout("/Users/mike/Library/Application Support/SubKit", "default")).toEqual({
      root: "/Users/mike/Library/Application Support/SubKit/local/default",
      pgdata: "/Users/mike/Library/Application Support/SubKit/local/default/pgdata",
      files: "/Users/mike/Library/Application Support/SubKit/local/default/files",
      backups: "/Users/mike/Library/Application Support/SubKit/local/default/backups",
      logs: "/Users/mike/Library/Application Support/SubKit/local/default/logs",
      state: "/Users/mike/Library/Application Support/SubKit/local/default/local-engine.json",
    });
    expect(localLayout("C:\\Data\\SubKit", "default", "\\").pgdata).toBe(
      "C:\\Data\\SubKit\\local\\default\\pgdata",
    );
    expect(() => localLayout("/x", "../up")).toThrow(/not allowed/);
  });
});

describe("data folder", () => {
  test("parses the mount table", () => {
    expect(MOUNTS).toContainEqual({ mountPoint: "/Volumes/share", type: "smbfs" });
    expect(MOUNTS).toContainEqual({ mountPoint: "/Volumes/nfs data", type: "nfs" });
  });

  test("refuses network and cloud-synced folders and accepts local ones", () => {
    expect(dataFolderRefusal("/Users/mike/Library/Application Support/SubKit", MAC)).toBeNull();
    expect(dataFolderRefusal("/Volumes/share/SubKit", MAC)).toBe("network_folder");
    expect(dataFolderRefusal("/Volumes/nfs data/x", MAC)).toBe("network_folder");
    expect(dataFolderRefusal("/Volumes/share", MAC)).toBe("network_folder");
    expect(dataFolderRefusal("/Volumes/Share/SubKit", MAC)).toBeNull();
    expect(dataFolderRefusal("/Volumes/shared/SubKit", MAC)).toBeNull();
    for (const synced of [
      "/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/SubKit",
      "/Users/mike/Library/CloudStorage/GoogleDrive-mike/SubKit",
      "/Users/mike/Dropbox/SubKit",
      "/Users/mike/OneDrive - Firma/SubKit",
      "/Users/mike/Dropbox (Personal)/SubKit",
      "/Users/mike/Dropbox (Team Firma)/SubKit",
      "/Users/mike/Google Drive/SubKit",
      "/Users/mike/iCloud Drive (Archive)/SubKit",
    ])
      expect(dataFolderRefusal(synced, MAC)).toBe("cloud_synced_folder");
    expect(dataFolderRefusal("/Users/mike/Dropboxes", MAC)).toBeNull();
    expect(dataFolderRefusal("relative/path", MAC)).toBe("relative_path");
    expect(dataFolderRefusal("/Users/mike/SubKit/../Dropbox/x", MAC)).toBe("relative_path");
    expect(dataFolderRefusal("/Users/mike/Documents/SubKit", MAC)).toBeNull();
  });

  test("refuses AFP and FUSE mounts such as file-provider drives", () => {
    const mounts = parseMountTable(
      [
        "//mike@nas._afpovertcp._tcp.local/Home on /Volumes/Home (afpfs, nodev, nosuid)",
        "drive on /Volumes/GoogleDrive (macfuse, nodev, nosuid, synchronous)",
        "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)",
      ].join("\n"),
    );
    const context = { ...MAC, mounts };
    expect(dataFolderRefusal("/Volumes/Home/SubKit", context)).toBe("network_folder");
    expect(dataFolderRefusal("/Volumes/GoogleDrive/SubKit", context)).toBe("network_folder");
    expect(dataFolderRefusal("/Users/mike/Documents/SubKit", context)).toBeNull();
  });

  test("on a Mac only the synced folders at the top of home count, and every network type", () => {
    expect(dataFolderRefusal("/Users/mike/Projects/Dropbox/SubKit", MAC)).toBeNull();
    expect(dataFolderRefusal("/Users/mike/Dropbox", MAC)).toBe("cloud_synced_folder");
    expect(dataFolderRefusal("/Users/mike/Box", MAC)).toBe("cloud_synced_folder");
    expect(dataFolderRefusal("/Users/mike/Dropbox/x", { ...MAC, home: "/Users/mike//" })).toBe(
      "cloud_synced_folder",
    );
    for (const type of ["smbfs", "nfs", "afpfs", "webdav", "cifs", "ftp", "9p", "osxfuse"]) {
      const mounts = [{ mountPoint: "/Volumes/remote", type }];
      expect(dataFolderRefusal("/Volumes/remote", { ...MAC, mounts })).toBe("network_folder");
    }
    const local = [{ mountPoint: "/Volumes/remote", type: "apfs" }];
    expect(dataFolderRefusal("/Volumes/remote/x", { ...MAC, mounts: local })).toBeNull();
    const slashed = [{ mountPoint: "/Volumes/remote//", type: "nfs" }];
    expect(dataFolderRefusal("/Volumes/remote/x", { ...MAC, mounts: slashed })).toBe(
      "network_folder",
    );
    const nested = [
      { mountPoint: "/Volumes/remote", type: "nfs" },
      { mountPoint: "/Volumes/remote/local", type: "apfs" },
    ];
    expect(dataFolderRefusal("/Volumes/remote/local/x", { ...MAC, mounts: nested })).toBeNull();
  });

  test("the mount table skips lines it does not understand and trims types", () => {
    expect(parseMountTable(["garbage", "x on /Volumes/y (smbfs , nodev)"].join("\n"))).toEqual([
      { mountPoint: "/Volumes/y", type: "smbfs" },
    ]);
  });

  test("refuses UNC paths and synced folders on Windows", () => {
    expect(dataFolderRefusal("C:\\Users\\Mike\\AppData\\Roaming\\SubKit", WIN)).toBeNull();
    expect(dataFolderRefusal("\\\\server\\share\\SubKit", WIN)).toBe("network_folder");
    expect(dataFolderRefusal("C:\\Users\\Mike\\OneDrive - Firma\\SubKit", WIN)).toBe(
      "cloud_synced_folder",
    );
    expect(dataFolderRefusal("SubKit", WIN)).toBe("relative_path");
  });

  test("falls back to a short socket folder when the socket path is too long", () => {
    expect(
      socketDirectoryFor(
        "/Users/mike/Library/Application Support/SubKit/local/default/pgdata",
        "/tmp/subkit",
      ),
    ).toBe("/Users/mike/Library/Application Support/SubKit/local/default/pgdata");
    const long = `/Users/mike/${"x".repeat(80)}/pgdata`;
    expect(socketDirectoryFor(long, "/tmp/subkit")).toBe("/tmp/subkit");
  });
});

describe("postgres settings", () => {
  test("the laptop profile listens on the socket only, with small memory and no JIT", () => {
    const args = laptopPostgresSettings({ kind: "socket", directory: "/tmp/subkit" });
    expect(args).toContain("shared_buffers=64MB");
    expect(args).toContain("max_connections=50");
    expect(args).toContain("jit=off");
    expect(args).toContain("listen_addresses=");
    expect(args).toContain("unix_socket_directories=/tmp/subkit");
    expect(args).toContain("unix_socket_permissions=0700");
    const tcp = laptopPostgresSettings({ kind: "tcp", host: "127.0.0.1", port: 55001 });
    expect(tcp).toContain("listen_addresses=127.0.0.1");
    expect(tcp).toContain("port=55001");
  });

  test("builds the engine database URL for a socket and for loopback", () => {
    expect(databaseUrl({ kind: "socket", directory: "/tmp/subkit" }, "p@ss")).toBe(
      "postgres://subkit:p%40ss@/postgres?host=%2Ftmp%2Fsubkit",
    );
    expect(databaseUrl({ kind: "tcp", host: "127.0.0.1", port: 55001 }, "pw")).toBe(
      "postgres://subkit:pw@127.0.0.1:55001/postgres",
    );
  });
});

describe("updates and backups", () => {
  test("backs up before a newer engine migrates and refuses a downgrade", () => {
    expect(compareVersions("11.10.0", "11.9.3")).toBe(1);
    expect(upgradePlan(null, "11.3.0")).toBe("first_run");
    expect(upgradePlan("11.3.0", "11.3.0")).toBe("same_version");
    expect(upgradePlan("11.3.0", "11.4.0")).toBe("backup_then_migrate");
    expect(upgradePlan("11.4.0", "11.3.0")).toBe("downgrade_refused");
  });

  test("keeps the last three automatic backups and every manual one", () => {
    const at = (day: number) => backupName(new Date(Date.UTC(2026, 10, day, 8, 0, 0)), "update");
    expect(at(1)).toBe("2026-11-01T08-00-00Z-update");
    const names = [at(4), at(1), at(3), at(2), at(5), "2026-11-02T09-00-00Z-manual"];
    expect(backupsToPrune(names)).toEqual([at(1), at(2)]);
    expect(backupsToPrune([at(1)])).toEqual([]);
    const before = (day: number) =>
      backupName(new Date(Date.UTC(2026, 10, day, 8, 0, 0)), "restore");
    expect(backupsToPrune([before(1), before(2), before(3), before(4), at(1)])).toEqual([
      before(1),
    ]);
  });
});

describe("supervisor", () => {
  const run = (events: SupervisorEvent[], from: SupervisorState = INITIAL_SUPERVISOR_STATE) =>
    events.reduce(nextSupervisorState, from);

  test("starts database first, backs up before migrating, then the engine", () => {
    const update = run([
      { type: "start" },
      { type: "prepared", plan: "backup_then_migrate" },
      { type: "database_ready" },
    ]);
    expect(update.phase).toBe("backing_up");
    expect(nextSupervisorState(update, { type: "engine_ready", port: 50_000 }).phase).toBe(
      "backing_up",
    );
    expect(
      run([{ type: "backup_done" }, { type: "engine_ready", port: 50_000 }], update),
    ).toMatchObject({ phase: "running", port: 50_000 });
    expect(
      run([{ type: "start" }, { type: "prepared", plan: "first_run" }, { type: "database_ready" }])
        .phase,
    ).toBe("starting_engine");
  });

  test("refuses a downgrade before anything starts", () => {
    expect(run([{ type: "start" }, { type: "prepared", plan: "downgrade_refused" }])).toMatchObject(
      {
        phase: "failed",
        reason: "downgrade_refused",
      },
    );
  });

  test("restarts after a crash and fails after too many", () => {
    const running = run([
      { type: "start" },
      { type: "prepared", plan: "same_version" },
      { type: "database_ready" },
      { type: "engine_ready", port: 50_000 },
    ]);
    const crashed = nextSupervisorState(running, {
      type: "crashed",
      process: "engine",
      plan: { delay_ms: 1000, crashes: [1] },
    });
    expect(crashed).toMatchObject({ phase: "restarting", port: null });
    expect(run([{ type: "retry" }, { type: "database_ready" }], crashed).phase).toBe(
      "starting_engine",
    );
    expect(
      nextSupervisorState(running, {
        type: "crashed",
        process: "database",
        plan: null,
      }),
    ).toMatchObject({ phase: "failed", reason: "database_keeps_crashing" });
  });

  test("a crash while stopping is not a crash", () => {
    const stopping = nextSupervisorState(
      { ...INITIAL_SUPERVISOR_STATE, phase: "running", port: 1 },
      { type: "stop" },
    );
    expect(
      nextSupervisorState(stopping, {
        type: "crashed",
        process: "engine",
        plan: { delay_ms: 1, crashes: [1] },
      }).phase,
    ).toBe("stopping");
    expect(nextSupervisorState(stopping, { type: "stopped" }).phase).toBe("stopped");
  });
});

describe("engine ready line", () => {
  test("trusts only a well-formed ready line", () => {
    expect(
      parseEngineReady('{"event":"subkit.local_workspace.ready","port":50001,"reassigned":true}'),
    ).toEqual({ port: 50_001, reassigned: true });
    expect(parseEngineReady('{"level":"info","msg":"subkit.local_workspace.ready"}')).toBeNull();
    expect(parseEngineReady('{"event":"subkit.local_workspace.ready","port":80}')).toBeNull();
    expect(parseEngineReady("subkit.local_workspace.ready 50001")).toBeNull();
  });
});
