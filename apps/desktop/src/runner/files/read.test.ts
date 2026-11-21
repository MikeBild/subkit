import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  boundaryFor,
  DEVICE,
  harness,
  inFolder,
  makeTree,
  PERSONAL,
  snapshotFor,
  type Tree,
} from "./files.fixture.ts";
import { DEFAULT_POLICY } from "./resolve.ts";

let tree: Tree;
beforeEach(() => {
  tree = makeTree();
});
afterEach(() => tree.cleanup());

function workflow(access: "read" | "write" = "read") {
  const docs = tree.folder("docs", tree.docs, access);
  const snapshot = snapshotFor(tree, [docs]);
  const boundary = boundaryFor([docs]);
  return { docs, snapshot, boundary, h: harness({ tree, snapshot }) };
}

describe("files.read_text in workflow mode", () => {
  test("reads text with hashes and sizes, never contents, in the evidence", async () => {
    tree.file(join(tree.docs, "a.txt"), "hello");
    const { docs, boundary, h } = workflow();
    const result = await h.run("files.read_text", { target: inFolder(docs, "a.txt"), boundary });
    expect(result).toMatchObject({
      status: "done",
      output: {
        text: "hello",
        size: 5,
        sha256: createHash("sha256").update("hello").digest("hex"),
      },
    });
    if (result.status !== "done") throw new Error("expected done");
    expect(result.evidence.before_version).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.evidence)).not.toContain("hello");
  });

  test("refuses a symlink that leads out of the folder", async () => {
    tree.file(join(tree.out, "secret.txt"), "outside");
    symlinkSync(join(tree.out, "secret.txt"), join(tree.docs, "link.txt"));
    symlinkSync(tree.out, join(tree.docs, "escape"));
    const { docs, boundary, h } = workflow();
    for (const path of ["link.txt", "escape/secret.txt"]) {
      expect(
        await h.run("files.read_text", { target: inFolder(docs, path), boundary }),
      ).toMatchObject({
        status: "refused",
        code: "outside_allowance",
      });
    }
  });

  test("follows a symlink that stays inside the folder", async () => {
    tree.file(join(tree.docs, "real.txt"), "inside");
    symlinkSync(join(tree.docs, "real.txt"), join(tree.docs, "alias.txt"));
    const { docs, boundary, h } = workflow();
    expect(
      await h.run("files.read_text", { target: inFolder(docs, "alias.txt"), boundary }),
    ).toMatchObject({ status: "done", output: { text: "inside" } });
  });

  test.each([
    ["../outside/x.txt", "outside_allowance"],
    ["/etc/hosts", "outside_allowance"],
    [".ssh/config", "hidden_path"],
    ["Talk.key", "secret_file"],
    ["Secret.KEY", "secret_file"],
    ["id_rsa", "secret_file"],
    ["LIBRARY/x.txt", "outside_allowance"],
    ["run.sh", "executable"],
    ["tool", "executable"],
  ])("refuses %s with %s", async (path, code) => {
    tree.file(join(tree.docs, "Talk.key", "Index.zip"), "zip");
    tree.file(join(tree.docs, "Talk.key", "Metadata", "Properties.plist"), "p");
    tree.file(join(tree.docs, "Secret.KEY"), "fake");
    tree.file(join(tree.docs, "id_rsa"), "fake");
    tree.file(join(tree.docs, "run.sh"), "echo");
    tree.file(join(tree.docs, "tool"), "bin", 0o755);
    tree.file(join(tree.docs, ".ssh", "config"), "x");
    const { docs, boundary, h } = workflow();
    expect(
      await h.run("files.read_text", { target: inFolder(docs, path), boundary }),
    ).toMatchObject({
      status: "refused",
      code,
    });
  });

  test("resolves another case on a case-insensitive volume to the canonical path", async () => {
    tree.file(join(tree.docs, "Sub", "a.txt"), "case");
    const { docs, boundary, h } = workflow();
    expect(
      await h.run("files.read_text", { target: inFolder(docs, "SUB/A.TXT"), boundary }),
    ).toMatchObject({ status: "done", output: { text: "case" } });
  });

  test("refuses a file with a second hard link", async () => {
    tree.file(join(tree.out, "shared.txt"), "two names");
    linkSync(join(tree.out, "shared.txt"), join(tree.docs, "shared.txt"));
    const { docs, boundary, h } = workflow();
    expect(
      await h.run("files.read_text", { target: inFolder(docs, "shared.txt"), boundary }),
    ).toMatchObject({ status: "refused", code: "outside_allowance" });
  });

  test("refuses text above 256 KiB", async () => {
    tree.file(join(tree.docs, "big.txt"), "x".repeat(256 * 1024 + 1));
    const { docs, boundary, h } = workflow();
    expect(
      await h.run("files.read_text", { target: inFolder(docs, "big.txt"), boundary }),
    ).toMatchObject({ status: "refused", code: "too_large" });
  });

  test("refuses with stale when the file changes during the read", async () => {
    const path = tree.file(join(tree.docs, "grow.txt"), "start");
    const docs = tree.folder("docs", tree.docs, "read");
    const h = harness({
      tree,
      snapshot: snapshotFor(tree, [docs]),
      hooks: { duringRead: async () => appendFileSync(path, " more") },
    });
    expect(
      await h.run("files.read_text", {
        target: inFolder(docs, "grow.txt"),
        boundary: boundaryFor([docs]),
      }),
    ).toMatchObject({ status: "refused", code: "stale" });
  });

  test("refuses with path_moved when the file is swapped before acting", async () => {
    const path = tree.file(join(tree.docs, "a.txt"), "first");
    const docs = tree.folder("docs", tree.docs, "read");
    const h = harness({
      tree,
      snapshot: snapshotFor(tree, [docs]),
      hooks: {
        afterPrepare: async () => {
          renameSync(path, join(tree.docs, "old.txt"));
          writeFileSync(path, "second");
        },
      },
    });
    expect(
      await h.run("files.read_text", {
        target: inFolder(docs, "a.txt"),
        boundary: boundaryFor([docs]),
      }),
    ).toMatchObject({ status: "refused", code: "path_moved" });
  });

  test("refuses with folder_changed when the allowed folder was replaced", async () => {
    tree.file(join(tree.docs, "a.txt"));
    const { docs, boundary, h } = workflow();
    renameSync(tree.docs, join(tree.home, "Docs-old"));
    mkdirSync(tree.docs);
    tree.file(join(tree.docs, "a.txt"));
    expect(
      await h.run("files.read_text", { target: inFolder(docs, "a.txt"), boundary }),
    ).toMatchObject({
      status: "refused",
      code: "folder_changed",
    });
  });

  test("a remount with a new st_dev keeps the folder when the volume UUID is the same", async () => {
    tree.file(join(tree.docs, "a.txt"), "same volume");
    const stored = { ...tree.folder("docs", tree.docs, "read"), volume_id: "uuid:VOLUME-1" };
    const h = harness({
      tree,
      snapshot: snapshotFor(tree, [stored]),
      volumeId: async () => "uuid:VOLUME-1",
    });
    expect(
      await h.run("files.read_text", {
        target: inFolder(stored, "a.txt"),
        boundary: boundaryFor([stored]),
      }),
    ).toMatchObject({ status: "done", output: { text: "same volume" } });
    const other = harness({
      tree,
      snapshot: snapshotFor(tree, [stored]),
      volumeId: async () => "uuid:VOLUME-2",
    });
    expect(
      await other.run("files.read_text", {
        target: inFolder(stored, "a.txt"),
        boundary: boundaryFor([stored]),
      }),
    ).toMatchObject({ status: "refused", code: "folder_changed" });
  });

  test("the default root check refuses a temporary folder", async () => {
    tree.file(join(tree.docs, "a.txt"));
    const docs = tree.folder("docs", tree.docs, "read");
    const h = harness({ tree, snapshot: snapshotFor(tree, [docs]), policy: DEFAULT_POLICY });
    expect(
      await h.run("files.read_text", {
        target: inFolder(docs, "a.txt"),
        boundary: boundaryFor([docs]),
      }),
    ).toMatchObject({ status: "refused", code: "outside_allowance" });
  });
});

describe("boundary and allowance in workflow mode", () => {
  test.each([
    ["personal switch off still allows workflows", "done"],
    ["folder missing from the boundary", "outside_boundary"],
    ["boundary of another device", "outside_boundary"],
    ["absolute path in a workflow", "outside_boundary"],
    ["boundary digest of an older folder", "folder_changed"],
  ])("%s refuses with %s", async (situation, code) => {
    tree.file(join(tree.docs, "a.txt"));
    const docs = tree.folder("docs", tree.docs, "read");
    const reports = tree.folder("reports", tree.reports, "read");
    const enabled = !situation.startsWith("personal switch off");
    const h = harness({ tree, snapshot: snapshotFor(tree, [docs, reports], [], enabled) });
    const boundary =
      situation === "folder missing from the boundary"
        ? boundaryFor([reports])
        : situation === "boundary of another device"
          ? { ...boundaryFor([docs]), device_id: "device-2" }
          : situation === "boundary digest of an older folder"
            ? boundaryFor([{ ...docs, file_id: "1" }])
            : boundaryFor([docs]);
    const target =
      situation === "absolute path in a workflow"
        ? { absolute: join(tree.docs, "a.txt") }
        : inFolder(docs, "a.txt");
    const result = await h.run("files.read_text", { target, boundary });
    if (code === "done") expect(result.status).toBe("done");
    else expect(result).toMatchObject({ status: "refused", code });
  });

  test("checks the boundary before the path rules", async () => {
    const docs = tree.folder("docs", tree.docs, "read");
    const h = harness({ tree, snapshot: snapshotFor(tree, [docs]) });
    expect(
      await h.run("files.read_text", {
        target: inFolder(docs, ".ssh/id_rsa"),
        boundary: { device_id: DEVICE, capability: "files", folders: [] },
      }),
    ).toMatchObject({ status: "refused", code: "outside_boundary" });
  });

  test("fails unreadable arguments", async () => {
    const { h } = workflow();
    expect(await h.run("files.read_text", { path: "/etc" })).toMatchObject({
      status: "failed",
      code: "bad_args",
    });
  });
});

describe("files.list", () => {
  test("lists entries and leaves out hidden, secret and protected names", async () => {
    tree.file(join(tree.docs, "a.txt"));
    tree.file(join(tree.docs, "b.pem"), "fake");
    tree.file(join(tree.docs, ".git", "config"));
    mkdirSync(join(tree.docs, "Library"));
    mkdirSync(join(tree.docs, "Sub"));
    const { docs, boundary, h } = workflow();
    const result = await h.run("files.list", { target: inFolder(docs, ""), boundary });
    expect(result).toMatchObject({
      status: "done",
      output: {
        entries: [
          { name: "Sub", kind: "folder" },
          { name: "a.txt", kind: "file", size: 5 },
        ],
        truncated: false,
        omitted: 3,
      },
    });
  });

  test("stops at 500 entries", async () => {
    for (let index = 0; index < 501; index++) tree.file(join(tree.docs, `f${index}.txt`), "x");
    const { docs, boundary, h } = workflow();
    const result = await h.run("files.list", { target: inFolder(docs, ""), boundary });
    if (result.status !== "done") throw new Error("expected done");
    const output = result.output as { entries: unknown[]; truncated: boolean };
    expect(output.entries).toHaveLength(500);
    expect(output.truncated).toBe(true);
  });
});

describe("personal mode", () => {
  function personal(keepOut: string[] = []) {
    return harness({ tree, snapshot: snapshotFor(tree, [], keepOut) });
  }

  test("reads anywhere the personal rules allow", async () => {
    const path = tree.file(join(tree.home, "Notes", "a.txt"), "note");
    expect(
      await personal().run("files.read_text", { target: { absolute: path } }, PERSONAL),
    ).toMatchObject({ status: "done", output: { text: "note" } });
  });

  test.each([
    ["keep-out folder", "Private/a.txt"],
    ["keep-out folder in another case", "PRIVATE/a.txt"],
    ["SubKit data folder", "Library/Application Support/SubKit/db.txt"],
  ])("refuses the %s", async (_name, relative) => {
    tree.file(join(tree.home, "Private", "a.txt"));
    tree.file(join(tree.data, "db.txt"));
    const result = await personal([join(tree.home, "Private")]).run(
      "files.read_text",
      { target: { absolute: join(tree.home, relative) } },
      PERSONAL,
    );
    expect(result).toMatchObject({ status: "refused", code: "outside_allowance" });
  });

  test("refuses the home folder itself and folder targets", async () => {
    const h = personal();
    expect(await h.run("files.list", { target: { absolute: tree.home } }, PERSONAL)).toMatchObject({
      status: "refused",
      code: "outside_allowance",
    });
    expect(
      await h.run("files.list", { target: { folder_id: "docs", path: "" } }, PERSONAL),
    ).toMatchObject({ status: "refused", code: "outside_boundary" });
  });

  test("refuses when the switch is off", async () => {
    const path = tree.file(join(tree.home, "a.txt"));
    const h = harness({ tree, snapshot: snapshotFor(tree, [], [], false) });
    expect(await h.run("files.read_text", { target: { absolute: path } }, PERSONAL)).toMatchObject({
      status: "refused",
      code: "outside_allowance",
    });
  });
});

describe("files.import", () => {
  test("streams the file to SubKit Files with its hash and size", async () => {
    tree.file(join(tree.docs, "invoice.pdf"), "%PDF-1.7 fake");
    const { docs, boundary, h } = workflow();
    const result = await h.run("files.import", { target: inFolder(docs, "invoice.pdf"), boundary });
    const sha256 = createHash("sha256").update("%PDF-1.7 fake").digest("hex");
    expect(result).toMatchObject({
      status: "done",
      output: { file_id: "file-1", name: "invoice.pdf", size: 13, sha256 },
    });
    expect(h.imported.committed).toBe(sha256);
    expect(Buffer.concat(h.imported.bytes).toString()).toBe("%PDF-1.7 fake");
  });

  test("aborts the upload when the file changes during the read", async () => {
    const path = tree.file(join(tree.docs, "grow.dat"), "start");
    const docs = tree.folder("docs", tree.docs, "read");
    const h = harness({
      tree,
      snapshot: snapshotFor(tree, [docs]),
      hooks: { duringRead: async () => appendFileSync(path, "more") },
    });
    expect(
      await h.run("files.import", {
        target: inFolder(docs, "grow.dat"),
        boundary: boundaryFor([docs]),
      }),
    ).toMatchObject({ status: "refused", code: "stale" });
    expect(h.imported.aborted).toBe(true);
    expect(h.imported.committed).toBeNull();
  });
});
