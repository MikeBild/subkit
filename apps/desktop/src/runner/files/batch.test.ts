import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  boundaryFor,
  harness,
  inFolder,
  makeTree,
  snapshotFor,
  type Tree,
} from "./files.fixture.ts";
import { probeCaseSensitive } from "./resolve.ts";

let tree: Tree;
beforeEach(() => {
  tree = makeTree();
});
afterEach(() => tree.cleanup());

function setup(
  options: { trashWorks?: boolean; hooks?: Parameters<typeof harness>[0]["hooks"] } = {},
) {
  const docs = tree.folder("docs", tree.docs, "write");
  const reports = tree.folder("reports", tree.reports, "read");
  const h = harness({
    tree,
    snapshot: snapshotFor(tree, [docs, reports]),
    trashWorks: options.trashWorks,
    hooks: options.hooks,
  });
  return { docs, reports, h, boundary: boundaryFor([docs, reports]) };
}

function items(result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>) {
  if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);
  return (result.output as { items: unknown[] }).items;
}

describe("files.move", () => {
  test("moves a file and a folder, each with its own result", async () => {
    tree.file(join(tree.docs, "a.txt"), "A");
    tree.file(join(tree.docs, "Old", "x.txt"), "X");
    mkdirSync(join(tree.docs, "Archive"));
    const { docs, h, boundary } = setup();
    const result = await h.run("files.move", {
      boundary,
      items: [
        { from: inFolder(docs, "a.txt"), to: inFolder(docs, "Archive/a.txt") },
        { from: inFolder(docs, "Old"), to: inFolder(docs, "Archive/Old") },
      ],
    });
    expect(items(result)).toEqual([
      { index: 0, status: "done", version: expect.any(String) },
      { index: 1, status: "done", version: expect.any(String) },
    ]);
    expect(readFileSync(join(tree.docs, "Archive", "a.txt"), "utf8")).toBe("A");
    expect(existsSync(join(tree.docs, "a.txt"))).toBe(false);
    expect(readFileSync(join(tree.docs, "Archive", "Old", "x.txt"), "utf8")).toBe("X");
  });

  test("never moves onto an existing name", async () => {
    tree.file(join(tree.docs, "a.txt"), "A");
    tree.file(join(tree.docs, "b.txt"), "B");
    const { docs, h, boundary } = setup();
    const result = await h.run("files.move", {
      boundary,
      items: [{ from: inFolder(docs, "a.txt"), to: inFolder(docs, "b.txt") }],
    });
    expect(items(result)).toEqual([{ index: 0, status: "failed", code: "target_exists" }]);
    expect(readFileSync(join(tree.docs, "b.txt"), "utf8")).toBe("B");
    expect(readFileSync(join(tree.docs, "a.txt"), "utf8")).toBe("A");
  });

  test("renames only the case on a case-insensitive volume", async () => {
    tree.file(join(tree.docs, "notes.txt"), "N");
    if (await probeCaseSensitive(tree.docs)) return;
    const { docs, h, boundary } = setup();
    const result = await h.run("files.move", {
      boundary,
      items: [{ from: inFolder(docs, "notes.txt"), to: inFolder(docs, "Notes.txt") }],
    });
    expect(items(result)).toMatchObject([{ index: 0, status: "done" }]);
    expect(readdirSync(tree.docs)).toEqual(["Notes.txt"]);
  });

  test.each([
    ["into a read-only folder", "a.txt", "reports:a.txt", "outside_boundary"],
    ["to a program name", "a.txt", "docs:a.sh", "executable"],
    ["an existing program", "run.sh", "docs:run2.sh", "executable"],
    ["a symlink", "link.txt", "docs:moved.txt", "outside_allowance"],
    ["out of the folder", "a.txt", "docs:../a.txt", "outside_allowance"],
  ])("refuses moving %s", async (_name, from, to, code) => {
    tree.file(join(tree.docs, "a.txt"));
    tree.file(join(tree.docs, "run.sh"));
    symlinkSync(join(tree.docs, "a.txt"), join(tree.docs, "link.txt"));
    const { docs, h, boundary } = setup();
    const [folderId, path] = to.split(":") as [string, string];
    const result = await h.run("files.move", {
      boundary,
      items: [{ from: inFolder(docs, from), to: { folder_id: folderId, path } }],
    });
    expect(items(result)).toEqual([{ index: 0, status: "refused", code }]);
  });

  test("marks the rest as not run after stop", async () => {
    tree.file(join(tree.docs, "a.txt"));
    tree.file(join(tree.docs, "b.txt"));
    const controller = new AbortController();
    const { docs, boundary } = setup();
    const h = harness({
      tree,
      snapshot: snapshotFor(tree, [docs]),
      hooks: { afterPrepare: async () => controller.abort() },
    });
    const result = await h.run(
      "files.move",
      {
        boundary,
        items: [
          { from: inFolder(docs, "a.txt"), to: inFolder(docs, "a2.txt") },
          { from: inFolder(docs, "b.txt"), to: inFolder(docs, "b2.txt") },
        ],
      },
      {},
      controller.signal,
    );
    expect(items(result)).toMatchObject([
      { index: 0, status: "done" },
      { index: 1, status: "not_run", code: "stopped" },
    ]);
    expect(existsSync(join(tree.docs, "b.txt"))).toBe(true);
  });

  test("reports progress at most every ten seconds during a batch", async () => {
    for (const name of ["a", "b", "c"]) tree.file(join(tree.docs, `${name}.txt`));
    const docs = tree.folder("docs", tree.docs, "write");
    let clock = 0;
    const notes: string[] = [];
    const h = harness({
      tree,
      snapshot: snapshotFor(tree, [docs]),
      now: () => {
        clock += 6_000;
        return clock;
      },
      progress: (commandId, note) => notes.push(`${commandId}:${note}`),
    });
    await h.run("files.trash", {
      boundary: boundaryFor([docs]),
      items: ["a", "b", "c"].map((name) => inFolder(docs, `${name}.txt`)),
    });
    expect(notes).toEqual(["c1:item 2 of 3"]);
  });

  test("refuses more than 200 items", async () => {
    const { docs, h, boundary } = setup();
    const item = { from: inFolder(docs, "a.txt"), to: inFolder(docs, "b.txt") };
    expect(
      await h.run("files.move", { boundary, items: Array.from({ length: 201 }, () => item) }),
    ).toMatchObject({ status: "failed", code: "bad_args" });
  });
});

describe("files.trash", () => {
  test("moves items to the Trash through main, never deleting", async () => {
    tree.file(join(tree.docs, "a.txt"), "A");
    tree.file(join(tree.docs, "Old", "x.txt"));
    const { docs, h, boundary } = setup();
    const result = await h.run("files.trash", {
      boundary,
      items: [inFolder(docs, "a.txt"), inFolder(docs, "Old")],
    });
    expect(items(result)).toMatchObject([
      { index: 0, status: "done" },
      { index: 1, status: "done" },
    ]);
    expect(h.trashed).toEqual([join(tree.docs, "a.txt"), join(tree.docs, "Old")]);
    expect(readdirSync(tree.trash)).toHaveLength(2);
  });

  test("reports an item as trashed when it left its place despite a false answer", async () => {
    tree.file(join(tree.docs, "a.txt"));
    const docs = tree.folder("docs", tree.docs, "write");
    const h = harness({ tree, snapshot: snapshotFor(tree, [docs]), trashAnswersFalse: true });
    const result = await h.run("files.trash", {
      boundary: boundaryFor([docs]),
      items: [inFolder(docs, "a.txt")],
    });
    expect(items(result)).toMatchObject([{ index: 0, status: "done" }]);
  });

  test("refuses per item without a working Trash", async () => {
    tree.file(join(tree.docs, "a.txt"));
    const { docs, h, boundary } = setup({ trashWorks: false });
    const result = await h.run("files.trash", { boundary, items: [inFolder(docs, "a.txt")] });
    expect(items(result)).toEqual([{ index: 0, status: "refused", code: "trash_unavailable" }]);
    expect(existsSync(join(tree.docs, "a.txt"))).toBe(true);
  });

  test("refuses secrets, symlinks, the folder itself and read-only folders", async () => {
    tree.file(join(tree.docs, "deck.key"), "fake");
    tree.file(join(tree.docs, "a.txt"));
    tree.file(join(tree.reports, "r.txt"));
    symlinkSync(join(tree.docs, "a.txt"), join(tree.docs, "link"));
    const { docs, reports, h, boundary } = setup();
    const result = await h.run("files.trash", {
      boundary,
      items: [
        inFolder(docs, "deck.key"),
        inFolder(docs, "link"),
        inFolder(docs, ""),
        inFolder(reports, "r.txt"),
      ],
    });
    expect(items(result)).toEqual([
      { index: 0, status: "refused", code: "secret_file" },
      { index: 1, status: "refused", code: "outside_allowance" },
      { index: 2, status: "refused", code: "outside_allowance" },
      { index: 3, status: "refused", code: "outside_boundary" },
    ]);
    expect(h.trashed).toEqual([]);
  });
});
