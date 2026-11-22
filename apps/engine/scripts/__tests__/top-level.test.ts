import { describe, expect, test } from "bun:test";
import { TOP_LEVEL_DIRECTORIES, unexpectedTopLevelEntries } from "../audit/top-level.ts";

describe("top-level layout", () => {
  test("accepts the pinned folders and files", () => {
    expect(
      unexpectedTopLevelEntries([
        "Dockerfile",
        "docker/entrypoint.sh",
        "apps/engine/src/index.ts",
        "packages/ui/contract/cockpit-ui.css",
        "",
      ]),
    ).toEqual([]);
  });

  test("names every stray folder once and every stray file", () => {
    expect(
      unexpectedTopLevelEntries([
        "contract/cockpit-ui.css",
        "agent-skills/build-or-adopt/SKILL.md",
        "deploy/docker/entrypoint.sh",
        "deploy/docker/subkit-wrap.sh",
        "notes.md",
        "scripts/run.ts",
      ]),
    ).toEqual(["agent-skills/", "contract/", "deploy/", "notes.md"]);
  });

  test("every pinned folder states its job", () => {
    for (const job of Object.values(TOP_LEVEL_DIRECTORIES))
      expect(job.trim().length).toBeGreaterThan(0);
  });

  test("a file named like an allowed folder is still a stray file", () => {
    expect(unexpectedTopLevelEntries(["docker"])).toEqual(["docker"]);
  });
});
