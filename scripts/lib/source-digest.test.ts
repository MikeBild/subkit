import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { digestGitVisibleSnapshot, type GitVisibleSnapshot } from "./source-digest.ts";

const snapshot = (overrides: Partial<GitVisibleSnapshot> = {}): GitVisibleSnapshot => ({
  revision: "0123456789abcdef",
  status: "",
  diff: "",
  untracked: [],
  ...overrides,
});

describe("digestGitVisibleSnapshot", () => {
  test("is deterministic regardless of untracked-file enumeration order", () => {
    const files = [
      { path: "z.bin", content: Uint8Array.from([0, 255]) },
      { path: "a.bin", content: Uint8Array.from([1, 2]) },
    ];
    expect(digestGitVisibleSnapshot(snapshot({ untracked: files }))).toBe(
      digestGitVisibleSnapshot(snapshot({ untracked: [...files].reverse() })),
    );
  });

  test("distinguishes invalid UTF-8 bytes in untracked source", () => {
    const first = digestGitVisibleSnapshot(
      snapshot({ untracked: [{ path: "binary", content: Uint8Array.of(255) }] }),
    );
    const second = digestGitVisibleSnapshot(
      snapshot({ untracked: [{ path: "binary", content: Uint8Array.of(254) }] }),
    );
    expect(first).not.toBe(second);
  });

  test("frames filenames and NUL-containing content without legacy delimiter collisions", () => {
    const oneFile = snapshot({
      untracked: [{ path: "a", content: Uint8Array.from([98, 0, 99, 0, 100]) }],
    });
    const twoFiles = snapshot({
      untracked: [
        { path: "a", content: Uint8Array.of(98) },
        { path: "c", content: Uint8Array.of(100) },
      ],
    });
    const legacy = (value: GitVisibleSnapshot) =>
      createHash("sha256")
        .update(value.revision)
        .update(value.status)
        .update(value.diff)
        .update(
          [...value.untracked]
            .sort((left, right) => left.path.localeCompare(right.path))
            .map(({ path, content }) => `${path}\0${Buffer.from(content).toString("utf8")}`)
            .join("\0"),
        )
        .digest("hex");
    expect(legacy(oneFile)).toBe(legacy(twoFiles));
    expect(digestGitVisibleSnapshot(oneFile)).not.toBe(digestGitVisibleSnapshot(twoFiles));
  });

  test("changes for tracked revision, status, and binary diff evidence", () => {
    const base = snapshot();
    const baseline = digestGitVisibleSnapshot(base);
    expect(digestGitVisibleSnapshot({ ...base, revision: "fedcba9876543210" })).not.toBe(baseline);
    expect(digestGitVisibleSnapshot({ ...base, status: " M source.ts\0" })).not.toBe(baseline);
    expect(digestGitVisibleSnapshot({ ...base, diff: "GIT binary patch\n" })).not.toBe(baseline);
  });
});
