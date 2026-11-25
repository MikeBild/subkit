import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  generateReleaseHistory,
  knownHighlights,
  mergeHighlights,
  pendingVersion,
  releaseHistoryFromRanges,
  releaseNotesFromSubjects,
  renderReleaseHistory,
} from "../gen-release-notes.ts";
import { ENGLISH_SUBJECTS, englishSubject } from "../lib/release-subjects.ts";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function commit(repo: string, subject: string): void {
  writeFileSync(join(repo, "history.txt"), `${subject}\n`, { flag: "a" });
  git(repo, "add", "history.txt");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    subject,
  );
}

describe("release notes generator", () => {
  test("keeps only explicitly user-facing feature and fix subjects", () => {
    expect(
      releaseNotesFromSubjects([
        "feat(user): show approximate model cost",
        "fix(user): retain local draft changes",
        "feat(chat): technical change",
        "chore: update tooling",
        "test: cover release notes",
        "fix(user): retain local draft changes",
      ]),
    ).toEqual(["show approximate model cost", "retain local draft changes"]);
  });

  test("keeps released versions separate from unpublished changes", () => {
    expect(
      releaseHistoryFromRanges({
        source: "abc123",
        releases: [
          { version: "v1.2.3", subjects: ["feat(user): add changes"] },
          { version: "v1.2.2", subjects: ["fix: technical change"] },
        ],
        unpublished: { version: null, subjects: ["fix(user): make costs clearer"] },
        highlights: {},
      }),
    ).toEqual({
      source: "abc123",
      releases: [
        { version: "v1.2.3", notes: ["add changes"], highlights: null },
        { version: "v1.2.2", notes: [], highlights: null },
      ],
      unpublished: { version: null, notes: ["make costs clearer"], highlights: null },
      highlights: {},
    });
  });

  test("attaches reviewed English highlights to released and pending versions", () => {
    const history = releaseHistoryFromRanges({
      source: "abc123",
      releases: [
        { version: "v1.2.2", subjects: ["feat(user): add changes"] },
        { version: "v1.2.3", subjects: [] },
      ],
      unpublished: { version: "1.3.0", subjects: ["feat(user): next"] },
      highlights: { "1.2.2": ["New"], "1.2.3": [], "1.3.0": ["Next"] },
    });
    expect(history.releases.map((r) => r.highlights)).toEqual([["New"], null]);
    expect(history.unpublished).toEqual({
      version: "1.3.0",
      notes: ["next"],
      highlights: ["Next"],
    });
  });

  test("keeps the highlights it generated before, later sources win", () => {
    const known = knownHighlights({
      source: "abc123",
      releases: [
        { version: "v1.2.2", notes: [], highlights: ["New"] },
        { version: "v1.2.3", notes: [], highlights: null },
      ],
      unpublished: { version: "1.3.0", notes: [], highlights: ["Next"] },
    });
    expect(known).toEqual({ "1.2.2": ["New"], "1.3.0": ["Next"] });
    expect(
      knownHighlights({
        source: "abc123",
        releases: [],
        unpublished: { version: null, notes: [], highlights: null },
        highlights: { "1.4.0": ["Kept"] },
      }),
    ).toEqual({ "1.4.0": ["Kept"] });
    expect(mergeHighlights(known, { "1.2.2": ["New, edited"] }, { "1.3.0": ["Fresh"] })).toEqual({
      "1.2.2": ["New, edited"],
      "1.3.0": ["Fresh"],
    });
    expect(mergeHighlights(known, { "1.2.2": [] }, null)["1.2.2"]).toEqual(["New"]);
  });

  test("the generated notes declare English-only highlights", () => {
    const rendered = renderReleaseHistory({
      source: "abc123",
      releases: [],
      unpublished: { version: null, notes: [], highlights: null },
      highlights: {},
    });
    expect(rendered).toContain("highlights: string[] | null");
    expect(rendered).not.toContain("de:");
  });

  test("historic subjects get their English text by commit hash", () => {
    const [hash, english] = Object.entries(ENGLISH_SUBJECTS)[0] as [string, string];
    expect(englishSubject(hash, "fix(user): original")).toBe(english);
    expect(englishSubject("0".repeat(40), "fix(user): keep")).toBe("fix(user): keep");
    for (const subject of Object.values(ENGLISH_SUBJECTS))
      expect(subject).toMatch(/^(feat|fix)\(user\): [\x20-\x7e]+$/);
  });

  test("a highlight never repeats a commit note of its own version", () => {
    const history = releaseHistoryFromRanges({
      source: "abc123",
      releases: [
        { version: "v1.2.3", subjects: ["fix(user): keep drafts"] },
        { version: "v1.2.4", subjects: ["fix(user): only a note"] },
      ],
      unpublished: { version: null, subjects: [] },
      highlights: { "1.2.3": ["Drafts survive a reload", "keep drafts"], "1.2.4": ["only a note"] },
    });
    expect(history.releases.map((release) => release.highlights)).toEqual([
      ["Drafts survive a reload"],
      null,
    ]);
    expect(history.highlights).toEqual({ "1.2.3": ["Drafts survive a reload"] });
  });

  test("keeps the reviewed highlights in version order", () => {
    expect(
      releaseHistoryFromRanges({
        source: "abc123",
        releases: [],
        unpublished: { version: null, subjects: [] },
        highlights: { "1.10.0": ["Ten"], "v1.9.0": ["Nine"], "1.2.0": [] },
      }).highlights,
    ).toEqual({ "1.9.0": ["Nine"], "1.10.0": ["Ten"] });
    expect(["1.10.0", "1.9.0"].sort(compareVersions)).toEqual(["1.9.0", "1.10.0"]);
  });

  test("the build of a tag carries its own highlights without GitHub", async () => {
    const repo = mkdtempSync(join(tmpdir(), "subkit-release-notes-"));
    const output = join(repo, "release-notes.generated.ts");
    const highlightsFile = join(repo, "highlights.md");
    const generate = (...args: string[]) =>
      execFileSync(
        "bun",
        ["scripts/gen-release-notes.ts", "--repo", repo, "--output", output, "--offline", ...args],
        { cwd: join(import.meta.dir, "../.."), encoding: "utf8" },
      );
    try {
      git(repo, "init");
      writeFileSync(join(repo, "package.json"), '{"version":"1.0.0"}\n');
      git(repo, "add", "package.json");
      commit(repo, "chore: establish history");
      git(repo, "tag", "v1.0.0");
      commit(repo, "fix: technical change");
      writeFileSync(join(repo, "package.json"), '{"version":"1.0.1"}\n');
      writeFileSync(highlightsFile, "## Highlights (en)\n\n- Uploads stay for a day\n");
      generate("--highlights", highlightsFile);
      git(repo, "add", "package.json", "release-notes.generated.ts");
      commit(repo, "chore(release): 1.0.1");
      git(repo, "tag", "v1.0.1");
      generate("--check");
      generate("--release", "v1.0.1");
      const { RELEASE_HISTORY } = (await import(output)) as {
        RELEASE_HISTORY: ReturnType<typeof releaseHistoryFromRanges>;
      };
      expect(RELEASE_HISTORY.releases.at(-1)).toEqual({
        version: "v1.0.1",
        notes: [],
        highlights: ["Uploads stay for a day"],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the package version is pending only while its tag does not exist", () => {
    expect(pendingVersion("1.3.0", ["v1.2.3"])).toBe("1.3.0");
    expect(pendingVersion("1.2.3", ["v1.2.2", "v1.2.3"])).toBeNull();
  });

  test("pins the git range before a generated artifact commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "subkit-release-notes-"));
    const output = join(repo, "release-notes.generated.ts");
    try {
      git(repo, "init");
      writeFileSync(join(repo, "package.json"), '{"version":"1.1.0"}\n');
      git(repo, "add", "package.json");
      commit(repo, "chore: establish history");
      commit(repo, "feat(user): first short note");
      git(repo, "tag", "v1.0.0");
      commit(repo, "fix(user): keep local changes");
      const source = git(repo, "rev-parse", "HEAD");
      const history = generateReleaseHistory(repo, source, { "1.1.0": ["New"] });
      expect(history).toEqual({
        source,
        releases: [{ version: "v1.0.0", notes: ["first short note"], highlights: null }],
        unpublished: {
          version: "1.1.0",
          notes: ["keep local changes"],
          highlights: ["New"],
        },
        highlights: { "1.1.0": ["New"] },
      });
      writeFileSync(output, renderReleaseHistory(history));
      commit(repo, "chore: generated release notes");
      execFileSync(
        "bun",
        [
          "scripts/gen-release-notes.ts",
          "--repo",
          repo,
          "--release",
          source,
          "--output",
          output,
          "--check",
          "--offline",
        ],
        { cwd: join(import.meta.dir, "../.."), encoding: "utf8" },
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
