import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { updateFeedProblem } from "./updates.ts";
import { compareVersions } from "./version.ts";

const app = join(import.meta.dir, "..", "..");
const repo = join(app, "..", "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function versionOf(path: string): string {
  return (JSON.parse(read(path)) as { version: string }).version;
}

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  steps: Step[];
}

const workflowText = read(join(repo, ".github/workflows/desktop-release.yml"));
const workflow = Bun.YAML.parse(workflowText) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const builder = Bun.YAML.parse(read(join(app, "electron-builder.yml"))) as {
  publish?: Record<string, unknown>;
  mac?: { notarize?: boolean };
};

describe("version coupling", () => {
  test("the app carries the version of the repository", () => {
    expect(versionOf(join(app, "package.json"))).toBe(versionOf(join(repo, "package.json")));
  });

  test("the bump script moves the app version with the repository version", () => {
    expect(read(join(repo, "scripts/bump-version.ts"))).toContain("apps/desktop/package.json");
  });

  test("the oldest app a server accepts by default is not newer than this app", () => {
    const schema = read(join(repo, "apps/engine/src/config/schema.ts"));
    const oldest = /DESKTOP_MIN_VERSION_DEFAULT = "(\d+\.\d+\.\d+)"/.exec(schema)?.[1];
    expect(oldest).toBeDefined();
    expect(compareVersions(versionOf(join(app, "package.json")), oldest ?? "")).not.toBe(-1);
  });
});

describe("update feed of the production build", () => {
  test("points at the releases of the repository and rolls out to everyone", () => {
    expect(updateFeedProblem(read(join(app, "electron-builder.yml")))).toBeNull();
    expect(builder.publish).toEqual({
      provider: "github",
      owner: "MikeBild",
      repo: "subkit",
      releaseType: "release",
      publishAutoUpdate: true,
    });
    expect(builder.mac?.notarize).toBe(true);
    expect(read(join(app, "electron-builder.yml"))).not.toContain("stagingPercentage");
    expect(read(join(app, "electron-builder.base.yml"))).toContain(
      "verifyUpdateCodeSignature: true",
    );
  });
});

describe("desktop release workflow", () => {
  const jobs = workflow.jobs;
  const steps = Object.values(jobs).flatMap((job) => job.steps);
  const scripts = steps.map((step) => step.run ?? "").join("\n");

  test("starts by hand, or after a release only when the owner opted in, never on a schedule", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(jobs.preflight?.if).toContain("vars.DESKTOP_RELEASE_AUTO == 'true'");
    expect(jobs.preflight?.if).toContain("github.event_name == 'workflow_dispatch'");
  });

  test("uses only actions pinned to a commit", () => {
    const actions = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  test("adds to the existing release and never creates or replaces one", () => {
    expect(scripts).toContain('gh release upload "$TAG"');
    expect(scripts).not.toContain("gh release create");
    expect(scripts).not.toContain("--clobber");
    expect(scripts).not.toMatch(/electron-builder(?![^\n]*--publish never)[^\n]*--(mac|win|linux)/);
    expect(scripts.match(/--publish never/g)?.length).toBe(7);
  });

  test("publishes only after every platform was built and never in a dry run", () => {
    expect(jobs.publish?.needs).toEqual(["preflight", "macos", "windows", "linux"]);
    expect(jobs.publish?.if).toContain("needs.preflight.outputs.dry_run != 'true'");
    for (const name of ["macos", "windows", "linux"]) expect(jobs[name]?.needs).toBe("preflight");
  });

  test("hands signing secrets only to steps that do not run in a dry run", () => {
    for (const job of Object.values(jobs))
      for (const step of job.steps) {
        const secrets = Object.values(step.env ?? {}).filter(
          (value) => value.includes("secrets.") && !value.includes("secrets.GITHUB_TOKEN"),
        );
        if (secrets.length)
          expect(`${job.if ?? ""} ${step.if ?? ""}`).toContain("dry_run != 'true'");
      }
  });

  test("a dry run builds without updates, a release build requires them", () => {
    const builds = steps.filter((step) => step.run?.includes("electron-builder --config"));
    expect(builds.length).toBe(7);
    for (const step of builds) {
      const dry = step.if?.includes("dry_run == 'true'") ?? false;
      expect(step.env?.SUBKIT_DESKTOP_UPDATES).toBe(dry ? "0" : "1");
    }
  });

  test("verifies signatures, notarization and the feed before anything is uploaded", () => {
    for (const check of [
      "codesign --verify --deep --strict",
      "spctl -a -t exec",
      "xcrun stapler validate",
      "verify /pa /all /v",
      "scripts/verify-feed.ts",
      "sha256sum --strict --check SHA256SUMS-desktop",
    ])
      expect(scripts).toContain(check);
    const publish = jobs.publish?.steps.map((step) => step.name ?? step.uses ?? "") ?? [];
    expect(publish.indexOf("Verify the update feeds against the artifacts")).toBeLessThan(
      publish.indexOf("Add the artifacts to the existing release"),
    );
    expect(publish.indexOf("Verify signature against the updater trust root")).toBeLessThan(
      publish.indexOf("Add the artifacts to the existing release"),
    );
  });
});
