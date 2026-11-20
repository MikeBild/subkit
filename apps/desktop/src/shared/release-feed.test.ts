import { describe, expect, test } from "bun:test";
import { type ArtifactFacts, feedProblems, readFeed } from "./release-feed.ts";

const artifacts = new Map<string, ArtifactFacts>([
  ["subkit-desktop-11.2.0-mac-arm64.zip", { sha512: "YXJt", size: 10 }],
  ["subkit-desktop-11.2.0-mac-x64.zip", { sha512: "eDY0", size: 12 }],
]);

function feed(extra: Record<string, unknown> = {}): unknown {
  return {
    version: "11.2.0",
    files: [
      { url: "subkit-desktop-11.2.0-mac-arm64.zip", sha512: "YXJt", size: 10 },
      { url: "subkit-desktop-11.2.0-mac-x64.zip", sha512: "eDY0", size: 12 },
    ],
    path: "subkit-desktop-11.2.0-mac-arm64.zip",
    sha512: "YXJt",
    ...extra,
  };
}

function problems(value: unknown): string[] {
  const parsed = readFeed(value);
  if (!parsed) throw new Error("feed did not parse");
  return feedProblems(parsed, "11.2.0", artifacts);
}

describe("update feed of a release", () => {
  test("a feed that matches the artifacts has no problem", () => {
    expect(problems(feed())).toEqual([]);
  });

  test("refuses what is not a feed", () => {
    for (const value of [null, "text", [], {}, { version: "1.0.0" }, { version: 1, files: [] }])
      expect(readFeed(value)).toBeNull();
    expect(readFeed({ version: "1.0.0", files: [{ url: "a.zip" }] })).toBeNull();
  });

  test("names another version, a staged rollout and an empty list", () => {
    expect(problems(feed({ version: "11.1.0" }))).toEqual([
      "names version 11.1.0 instead of 11.2.0",
    ]);
    expect(problems(feed({ stagingPercentage: 10 }))).toEqual([
      "carries a staged rollout percentage",
    ]);
    expect(problems(feed({ files: [] }))).toEqual(["lists no file"]);
  });

  test("names a missing file, a changed file and an address outside the release", () => {
    expect(
      problems(
        feed({
          files: [
            { url: "subkit-desktop-11.2.0-mac-arm64.zip", sha512: "b3RoZXI=", size: 10 },
            { url: "subkit-desktop-11.2.0-mac-x64.zip", sha512: "eDY0", size: 13 },
            { url: "subkit-desktop-11.2.0-win-x64.exe", sha512: "d2lu" },
            { url: "https://elsewhere.example/app.zip", sha512: "eA==" },
            { url: "../app.zip", sha512: "eA==" },
          ],
        }),
      ),
    ).toEqual([
      "has another SHA-512 for subkit-desktop-11.2.0-mac-arm64.zip",
      "has another size for subkit-desktop-11.2.0-mac-x64.zip",
      "lists subkit-desktop-11.2.0-win-x64.exe, which is not among the artifacts",
      "lists https://elsewhere.example/app.zip, which is not a plain file name of this release",
      "lists ../app.zip, which is not a plain file name of this release",
    ]);
  });
});
