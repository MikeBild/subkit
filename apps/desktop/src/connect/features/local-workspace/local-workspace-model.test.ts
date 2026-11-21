import { describe, expect, test } from "bun:test";
import { LOCAL_UNAVAILABLE, type LocalView } from "../../../shared/ipc.ts";
import { backupRows } from "../../../shared/local/local-workspace-model.ts";
import { backupItems, localWorkspaceFor, moveModel } from "./local-workspace-model.ts";

const view = (patch: Partial<LocalView> = {}): LocalView => ({
  ...LOCAL_UNAVAILABLE,
  available: true,
  configured: true,
  folder: "/Users/anna/Library/Application Support/SubKit",
  progress: { database: true, engine: true, workspace: true },
  ...patch,
});

describe("the backup list", () => {
  test("labels automatic, pre-restore and manual backups and shows megabytes", () => {
    const items = backupItems(
      backupRows([
        { name: "2026-11-20T08-00-00Z-update", sizeBytes: 24_000_000 },
        { name: "2026-11-21T08-00-00Z-manual", sizeBytes: null },
        { name: "2026-11-19T08-00-00Z-restore", sizeBytes: 1 },
      ]),
    );
    expect(items.map((item) => [item.label, item.sizeMb])).toEqual([
      ["workspace.manual", null],
      ["workspace.automatic", 24],
      ["workspace.beforeRestore", 1],
    ]);
  });
});

describe("the local workspace section", () => {
  test("shows the folder, size and status, and locks while one operation runs", () => {
    expect(localWorkspaceFor(view({ sizeBytes: 5_000_000 }))).toMatchObject({
      sizeMb: 5,
      running: true,
      locked: false,
      error: null,
    });
    expect(localWorkspaceFor(view({ busy: "backup" }))).toMatchObject({
      creating: true,
      restoring: false,
      locked: true,
    });
    expect(localWorkspaceFor(view({ busy: "restore" })).restoring).toBe(true);
    expect(localWorkspaceFor(view({ error: "restore" }))).toMatchObject({
      running: false,
      error: "restore",
    });
    expect(localWorkspaceFor(view({ error: "disk" })).error).toBeNull();
    expect(
      localWorkspaceFor(view({ progress: { database: true, engine: false, workspace: true } }))
        .running,
    ).toBe(false);
  });
});

describe("moving to a server", () => {
  const moved = { server: "https://subkit.example.com", bundle: "/x/b.zip" };

  test("asks for the server first and refuses an insecure address", () => {
    expect(moveModel(0, view(), "", false)).toMatchObject({ step: 0, canContinue: false });
    expect(moveModel(0, view(), "   ", false).canContinue).toBe(false);
    expect(moveModel(0, view(), "http://subkit.example.com", true)).toMatchObject({
      canContinue: true,
      urlError: true,
      origin: null,
    });
    expect(moveModel(0, view(), "http://subkit.example.com", false).urlError).toBe(false);
    expect(moveModel(0, view(), "subkit.example.com", true)).toMatchObject({
      urlError: false,
      origin: "https://subkit.example.com",
    });
    expect(moveModel(0, view(), "localhost:3000", true).origin).toBe("http://localhost:3000");
  });

  test("the confirmation waits while the export runs and the sign-in follows the move", () => {
    expect(moveModel(1, view(), "subkit.example.com", true)).toMatchObject({
      step: 1,
      busy: false,
      canContinue: true,
      urlError: false,
    });
    expect(moveModel(1, view({ busy: "move" }), "subkit.example.com", true)).toMatchObject({
      busy: true,
      canContinue: false,
    });
    expect(moveModel(1, view({ moved }), "", false)).toMatchObject({
      step: 2,
      canContinue: true,
    });
    expect(moveModel(2, view(), "", false).canContinue).toBe(false);
    expect(moveModel(1, view(), "http://subkit.example.com", true).urlError).toBe(false);
  });

  test("each operation and state shows as itself", () => {
    expect(localWorkspaceFor(view({ busy: "restore" })).creating).toBe(false);
    expect(localWorkspaceFor(view({ busy: "move" }))).toMatchObject({
      creating: false,
      restoring: false,
      removing: false,
      locked: true,
    });
    expect(localWorkspaceFor(view({ busy: "remove" })).removing).toBe(true);
    expect(localWorkspaceFor(view({ error: "move" })).error).toBe("move");
    expect(localWorkspaceFor(view({ moved })).moved).toEqual(moved);
    expect(localWorkspaceFor(view({ aiConfigured: false })).aiMissing).toBe(true);
    expect(localWorkspaceFor(view({ aiConfigured: true })).aiMissing).toBe(false);
    expect(localWorkspaceFor(view({ modelTools: false })).modelWithoutTools).toBe(true);
    expect(localWorkspaceFor(view({ modelTools: null })).modelWithoutTools).toBe(false);
    expect(localWorkspaceFor(view({ modelTools: true })).modelWithoutTools).toBe(false);
  });
});
