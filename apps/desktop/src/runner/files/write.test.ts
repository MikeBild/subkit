import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  boundaryFor,
  harness,
  inFolder,
  makeTree,
  PERSONAL,
  snapshotFor,
  type Tree,
} from "./files.fixture.ts";

let tree: Tree;
beforeEach(() => {
  tree = makeTree();
});
afterEach(() => tree.cleanup());

const text = (value: string) => ({ encoding: "utf8" as const, text: value });

function setup(
  options: {
    access?: "read" | "write";
    trashWorks?: boolean;
    hooks?: Parameters<typeof harness>[0]["hooks"];
  } = {},
) {
  const docs = tree.folder("docs", tree.docs, options.access ?? "write");
  const h = harness({
    tree,
    snapshot: snapshotFor(tree, [docs]),
    trashWorks: options.trashWorks,
    hooks: options.hooks,
  });
  return { docs, h, boundary: boundaryFor([docs]) };
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(".subkit-"));
}

describe("files.write", () => {
  test("creates a new file atomically, without execute bits, with a quarantine mark", async () => {
    const { docs, h, boundary } = setup();
    const result = await h.run("files.write", {
      target: inFolder(docs, "report.md"),
      boundary,
      content: text("# Report"),
    });
    const path = join(tree.docs, "report.md");
    expect(result).toMatchObject({
      status: "done",
      output: { size: 8, replaced: false, previous_in_trash: false, quarantined: true },
    });
    expect(readFileSync(path, "utf8")).toBe("# Report");
    expect(statSync(path).mode & 0o111).toBe(0);
    expect(statSync(path).nlink).toBe(1);
    expect(h.marked).toEqual([path]);
    expect(leftovers(tree.docs)).toEqual([]);
  });

  test("never overwrites without replace", async () => {
    const path = tree.file(join(tree.docs, "a.txt"), "old");
    const { docs, h, boundary } = setup();
    expect(
      await h.run("files.write", {
        target: inFolder(docs, "a.txt"),
        boundary,
        content: text("new"),
      }),
    ).toMatchObject({ status: "failed", code: "target_exists" });
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  test("replace moves the previous version to the Trash first", async () => {
    const path = tree.file(join(tree.docs, "a.txt"), "old");
    const { docs, h, boundary } = setup();
    const result = await h.run("files.write", {
      target: inFolder(docs, "a.txt"),
      boundary,
      content: text("new"),
      replace: true,
    });
    expect(result).toMatchObject({
      status: "done",
      output: { replaced: true, previous_in_trash: true },
      evidence: { before_version: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(h.trashed).toEqual([path]);
    const [trashed] = readdirSync(tree.trash);
    expect(readFileSync(join(tree.trash, trashed as string), "utf8")).toBe("old");
    expect(leftovers(tree.docs)).toEqual([]);
  });

  test("refuses replace without a working Trash and changes nothing", async () => {
    const path = tree.file(join(tree.docs, "a.txt"), "old");
    const { docs, h, boundary } = setup({ trashWorks: false });
    expect(
      await h.run("files.write", {
        target: inFolder(docs, "a.txt"),
        boundary,
        content: text("new"),
        replace: true,
      }),
    ).toMatchObject({ status: "refused", code: "trash_unavailable" });
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(statSync(path).nlink).toBe(1);
    expect(leftovers(tree.docs)).toEqual([]);
  });

  test("trusts the disk over a late Trash answer: a moved previous version counts as trashed", async () => {
    const path = tree.file(join(tree.docs, "a.txt"), "old");
    const docs = tree.folder("docs", tree.docs, "write");
    const h = harness({ tree, snapshot: snapshotFor(tree, [docs]), trashAnswersFalse: true });
    const result = await h.run("files.write", {
      target: inFolder(docs, "a.txt"),
      boundary: boundaryFor([docs]),
      content: text("new"),
      replace: true,
    });
    expect(result).toMatchObject({ status: "done", output: { previous_in_trash: true } });
    expect(readFileSync(path, "utf8")).toBe("new");
    const [trashed] = readdirSync(tree.trash);
    expect(readFileSync(join(tree.trash, trashed as string), "utf8")).toBe("old");
  });

  test("restores the previous version when placing the new one fails", async () => {
    const path = tree.file(join(tree.docs, "a.txt"), "old");
    const { docs, h, boundary } = setup({
      hooks: {
        beforePlace: async () => {
          for (const name of leftovers(tree.docs)) {
            if (name.endsWith(".tmp")) unlinkSync(join(tree.docs, name));
          }
        },
      },
    });
    const result = await h.run("files.write", {
      target: inFolder(docs, "a.txt"),
      boundary,
      content: text("new"),
      replace: true,
    });
    expect(result.status).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(leftovers(tree.docs)).toEqual([]);
  });

  test.each([
    ["run.sh", "executable"],
    ["tool.app", "executable"],
    [".env", "hidden_path"],
    ["id_rsa", "secret_file"],
    ["slides.key", "secret_file"],
    ["", "outside_allowance"],
  ])("refuses to create %s with %s", async (name, code) => {
    const { docs, h, boundary } = setup();
    expect(
      await h.run("files.write", { target: inFolder(docs, name), boundary, content: text("x") }),
    ).toMatchObject({ status: "refused", code });
    expect(leftovers(tree.docs)).toEqual([]);
  });

  test("refuses a read-only folder and content above 10 MiB", async () => {
    const readOnly = setup({ access: "read" });
    expect(
      await readOnly.h.run("files.write", {
        target: inFolder(readOnly.docs, "a.txt"),
        boundary: readOnly.boundary,
        content: text("x"),
      }),
    ).toMatchObject({ status: "refused", code: "outside_boundary" });
    const { docs, h, boundary } = setup();
    expect(
      await h.run("files.write", {
        target: inFolder(docs, "big.txt"),
        boundary,
        content: text("x".repeat(10 * 1024 * 1024 + 1)),
      }),
    ).toMatchObject({ status: "refused", code: "too_large" });
  });

  test("never writes through a symlink, neither leaf nor parent", async () => {
    tree.file(join(tree.out, "target.txt"), "outside");
    symlinkSync(join(tree.out, "target.txt"), join(tree.docs, "leaf.txt"));
    symlinkSync(tree.out, join(tree.docs, "escape"));
    const { docs, h, boundary } = setup();
    for (const [path, replace] of [
      ["leaf.txt", true],
      ["escape/new.txt", false],
    ] as const) {
      expect(
        await h.run("files.write", {
          target: inFolder(docs, path),
          boundary,
          content: text("x"),
          replace,
        }),
      ).toMatchObject({ status: "refused", code: "outside_allowance" });
    }
    expect(readFileSync(join(tree.out, "target.txt"), "utf8")).toBe("outside");
    expect(existsSync(join(tree.out, "new.txt"))).toBe(false);
  });

  test("refuses with path_moved when the parent is swapped for a symlink before placing", async () => {
    tree.file(join(tree.docs, "sub", "keep.txt"));
    const { docs, h, boundary } = setup({
      hooks: {
        afterPrepare: async () => {
          renameSync(join(tree.docs, "sub"), join(tree.docs, "sub-old"));
          symlinkSync(tree.out, join(tree.docs, "sub"));
        },
      },
    });
    const result = await h.run("files.write", {
      target: inFolder(docs, "sub/new.txt"),
      boundary,
      content: text("x"),
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(existsSync(join(tree.out, "new.txt"))).toBe(false);
  });

  test("does not run after stop", async () => {
    const { docs, h, boundary } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(
      await h.run(
        "files.write",
        { target: inFolder(docs, "a.txt"), boundary, content: text("x") },
        {},
        controller.signal,
      ),
    ).toEqual({ status: "stopped" });
    expect(existsSync(join(tree.docs, "a.txt"))).toBe(false);
  });

  test("writes base64 content in personal mode", async () => {
    const h = harness({ tree, snapshot: snapshotFor(tree, []) });
    const path = join(tree.home, "Notes.txt");
    expect(
      await h.run(
        "files.write",
        {
          target: { absolute: path },
          content: { encoding: "base64", data: Buffer.from("hi").toString("base64") },
        },
        PERSONAL,
      ),
    ).toMatchObject({ status: "done" });
    expect(readFileSync(path, "utf8")).toBe("hi");
  });
});

describe("files.mkdir", () => {
  test("creates one folder and never an existing or hidden one", async () => {
    const { docs, h, boundary } = setup();
    expect(
      await h.run("files.mkdir", { target: inFolder(docs, "Archive"), boundary }),
    ).toMatchObject({
      status: "done",
      output: { created: true },
    });
    expect(statSync(join(tree.docs, "Archive")).isDirectory()).toBe(true);
    expect(
      await h.run("files.mkdir", { target: inFolder(docs, "Archive"), boundary }),
    ).toMatchObject({
      status: "failed",
      code: "target_exists",
    });
    expect(
      await h.run("files.mkdir", { target: inFolder(docs, ".cache"), boundary }),
    ).toMatchObject({
      status: "refused",
      code: "hidden_path",
    });
    expect(await h.run("files.mkdir", { target: inFolder(docs, "a/b"), boundary })).toMatchObject({
      status: "failed",
      code: "not_found",
    });
  });
});
