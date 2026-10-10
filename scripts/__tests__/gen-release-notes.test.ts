import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateReleaseHistory,
  releaseHistoryFromRanges,
  releaseNotesFromSubjects,
  renderReleaseHistory,
} from "../gen-release-notes.ts";

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
        unpublished: ["fix(user): make costs clearer"],
      }),
    ).toEqual({
      source: "abc123",
      releases: [
        { version: "v1.2.3", notes: ["add changes"] },
        { version: "v1.2.2", notes: [] },
      ],
      unpublished: ["make costs clearer"],
    });
  });

  test("pins the git range before a generated artifact commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "subkit-release-notes-"));
    const output = join(repo, "release-notes.generated.ts");
    try {
      git(repo, "init");
      commit(repo, "chore: establish history");
      commit(repo, "feat(user): Erste Kurznotiz");
      git(repo, "tag", "v1.0.0");
      commit(repo, "fix(user): Lokale Änderungen behalten");
      const source = git(repo, "rev-parse", "HEAD");
      const history = generateReleaseHistory(repo, source);
      expect(history).toEqual({
        source,
        releases: [{ version: "v1.0.0", notes: ["Erste Kurznotiz"] }],
        unpublished: ["Lokale Änderungen behalten"],
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
        ],
        { cwd: join(import.meta.dir, "../.."), encoding: "utf8" },
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
