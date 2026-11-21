import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageSteps, parsePackageArgs } from "../../scripts/package.ts";
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
  "continue-on-error"?: unknown;
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

describe("local-mode engine bundle", () => {
  const base = read(join(app, "electron-builder.base.yml"));
  const parsed = Bun.YAML.parse(base) as {
    mac: {
      target: { arch: string[] }[];
      signIgnore: string[];
      extraResources: { from: string; to: string; filter?: string[] }[];
    };
    win?: { extraResources?: unknown[] };
  };
  const local = parsed.mac.extraResources.filter((entry) => entry.to.startsWith("local/"));

  test("one build: every macOS app carries the engine and PostgreSQL, no other platform does", () => {
    expect(local.map((entry) => entry.to)).toEqual(["local/engine", "local/postgres"]);
    expect(parsed.win?.extraResources).toBeUndefined();
    expect(base.match(/engine-desktop/g)).toHaveLength(1);
  });

  test("macOS ships for Apple silicon only", () => {
    for (const target of parsed.mac.target) expect(target.arch).toEqual(["arm64"]);
  });

  test("PostgreSQL is added as signed beforehand, without entitlements", () => {
    const postgres = local[1];
    expect(postgres?.from).toMatch(/^resources\/postgres\/darwin-\$\{arch\}$/);
    expect(postgres?.filter).toEqual(["**/*", "!.bundle.json"]);
    expect(parsed.mac.signIgnore).toContain("/Contents/Resources/local/postgres/");
  });

  test("the engine of the packaged architecture is added", () => {
    expect(local[0]?.from).toMatch(/^\.\.\/\.\.\/dist\/engine-desktop\/mac\/\$\{arch\}\/engine$/);
  });

  test("there is no switch and no second builder config for local mode", () => {
    const scripts = (
      JSON.parse(read(join(app, "package.json"))) as { scripts: Record<string, string> }
    ).scripts;
    const packaging = read(join(app, "scripts/package.ts"));
    expect(scripts.package).toBe("bun run scripts/package.ts");
    expect(packaging).toContain('"build", "desktop-engine"');
    expect(packaging).toContain('"scripts/fetch-postgres.ts", "--target", "darwin-arm64"');
    for (const text of [JSON.stringify(scripts), packaging]) {
      expect(text).not.toContain("LOCAL_ENGINE");
      expect(text).not.toContain("local-engine.yml");
    }
  });

  test("one package command stages, builds and hands the rest to the builder", () => {
    const run = (args: string[]) =>
      packageSteps(parsePackageArgs(args)).map((step) => step.argv.join(" "));
    expect(run([])).toEqual([
      "bun scripts/fetch-agent-desktop.ts",
      "bun scripts/fetch-agent-browser.ts",
      "bun run build desktop-engine",
      "bun scripts/fetch-postgres.ts --target darwin-arm64",
      "bun scripts/build.ts --production",
      "bun scripts/notices.ts",
      "bunx electron-builder --config electron-builder.yml",
    ]);
    expect(run(["--prebuilt", "--mac", "--publish", "never"])).toEqual([
      "bun scripts/build.ts --production",
      "bun scripts/notices.ts",
      "bunx electron-builder --config electron-builder.yml --mac --publish never",
    ]);
    expect(run(["--dev"]).slice(-3)).toEqual([
      "bun scripts/build.ts",
      "bun scripts/notices.ts",
      "bunx electron-builder --config electron-builder.dev.yml --dir",
    ]);
  });

  test("the engine runs with the JIT entitlement and nothing more", () => {
    const entitlements = read(join(app, "assets/entitlements.mac.plist"));
    expect(entitlements.match(/<key>[^<]+<\/key>/g)).toEqual([
      "<key>com.apple.security.cs.allow-jit</key>",
    ]);
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
    expect(scripts).not.toContain("electron-builder");
    expect(scripts).not.toMatch(/bun run package(?![^\n]*--publish never)[^\n]*--(mac|win|linux)/);
    expect(scripts.match(/--publish never/g)?.length).toBe(7);
  });

  test("publishes after the macOS build, never in a dry run, and waits for the other platforms", () => {
    expect(jobs.publish?.needs).toEqual(["preflight", "macos", "windows", "linux"]);
    expect(jobs.publish?.if).toContain("!cancelled()");
    expect(jobs.publish?.if).toContain("needs.preflight.outputs.dry_run != 'true'");
    expect(jobs.publish?.if).toContain("needs.macos.result == 'success'");
    for (const name of ["windows", "linux"]) {
      expect(jobs.publish?.if).not.toContain(`needs.${name}.`);
      expect(jobs[name]?.["continue-on-error"]).toBeUndefined();
    }
    expect(jobs.linux?.needs).toBe("preflight");
    expect(jobs.windows?.needs).toBe("preflight");
    expect(jobs.macos?.needs).toEqual(["preflight", "engine"]);
  });

  test("missing Windows signing values warn but never stop the macOS release", () => {
    const preflight = jobs.preflight?.steps ?? [];
    const script = preflight.find((step) => step.name === "Require signing secrets")?.run ?? "";
    const required = /required="([^"]+)"/.exec(script)?.[1]?.split(" ") ?? [];
    expect(required).toEqual([
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "RELEASE_SIGNING_KEY",
    ]);
    expect(script).not.toMatch(/required="\$required/);
    expect(script).toMatch(/for name in \$windows; do[\s\S]*::warning::/);
    expect(script.split("for name in $windows")[1]).not.toContain("exit 1");
  });

  test("a failed Windows or Linux build leaves only its own files out of the release", () => {
    const publish = jobs.publish?.steps ?? [];
    const collect = publish.find((step) => step.name === "Collect the artifacts of this run");
    const script = collect?.run ?? "";
    expect(script).toContain('names="desktop-macos"');
    expect(script).toContain('feeds="latest-mac.yml"');
    expect(script).toMatch(
      /if \[ "\$WINDOWS_RESULT" = "success" \]; then\s+names="\$names desktop-windows"\s+feeds="\$feeds latest\.yml"/,
    );
    expect(script).toMatch(
      /if \[ "\$LINUX_RESULT" = "success" \]; then\s+names="\$names desktop-linux"\s+feeds="\$feeds latest-linux\.yml"/,
    );
    expect(script).toContain('echo "FEEDS=$feeds" >> "$GITHUB_ENV"');
    const verifies = publish
      .map((step) => step.run ?? "")
      .filter((run) => run.includes("verify-feed.ts"));
    expect(verifies).toHaveLength(2);
    for (const run of verifies) expect(run).toMatch(/verify-feed\.ts "\$\w+" "\$VERSION" \$FEEDS/);
  });

  test("always builds the local-mode engine and packages macOS with the one builder config", () => {
    expect(jobs.engine?.needs).toBe("preflight");
    expect(jobs.engine?.if).toBeUndefined();
    expect(workflowText).not.toMatch(/local_engine|LOCAL_ENGINE|BUILDER_CONFIG|local-engine\.yml/);
    const staging = steps.filter((step) => step.run?.includes("--name engine-desktop-"));
    expect(staging.length).toBe(1);
    expect(staging[0]?.if).toBeUndefined();
  });

  test("signs the macOS engine with the app entitlements, notarizes it and starts it", () => {
    const engine = jobs.engine?.steps.map((step) => step.run ?? "").join("\n") ?? "";
    expect(engine).toContain("bun run build desktop-engine");
    expect(engine).toContain(
      'sh scripts/codesign-macos.sh dist/engine-desktop/mac/arm64/engine "$identity" apps/desktop/assets/entitlements.mac.plist',
    );
    expect(engine).toContain("sh scripts/notarize-macos.sh dist/engine-desktop/mac/arm64/engine");
    expect(engine).toContain('"$engine" --smoke');
    expect(engine).not.toContain("x64");
    expect(scripts).toContain("com.apple.security.cs.allow-jit");
  });

  test("fetches, signs and checks PostgreSQL for Apple silicon only, never on Windows", () => {
    const mac = jobs.macos?.steps ?? [];
    const fetch = mac.find((step) => step.name === "Fetch PostgreSQL for local mode");
    const sign = mac.find(
      (step) => step.name === "Sign PostgreSQL, agent-desktop and agent-browser",
    );
    const check = mac.find((step) => step.name?.startsWith("Check that the app carries"));
    expect(fetch?.if).toBeUndefined();
    expect(fetch?.run).toContain("scripts/fetch-postgres.ts --target darwin-arm64");
    expect(sign?.if).toContain("dry_run != 'true'");
    expect(sign?.run).toContain('sh scripts/codesign-macos-folder.sh "$postgres" "$identity"');
    expect(sign?.run).not.toContain("entitlements");
    expect(check?.run).toContain("local/postgres/bin/postgres");
    expect(check?.run).toContain("local/engine");
    const windows = (jobs.windows?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(windows).not.toContain("postgres");
    expect(mac.map((step) => step.run ?? "").join("\n")).not.toMatch(/\bx64\b|x86_64/);
  });

  test("fetches and presigns agent-desktop and agent-browser before the mac build", () => {
    const mac = jobs.macos?.steps ?? [];
    const names = mac.map((step) => step.name ?? "");
    const fetch = mac.find((step) => step.name === "Fetch agent-desktop and agent-browser");
    const sign = mac.find(
      (step) => step.name === "Sign PostgreSQL, agent-desktop and agent-browser",
    );
    const check = mac.find((step) => step.name?.startsWith("Check that the app carries"));
    expect(fetch?.if).toBeUndefined();
    expect(fetch?.run).toContain("bun run scripts/fetch-agent-desktop.ts");
    expect(fetch?.run).toContain("bun run scripts/fetch-agent-browser.ts darwin-arm64");
    expect(sign?.run).toContain('scripts/fetch-agent-desktop.ts --sign "$identity"');
    expect(sign?.run).toContain(
      'sh scripts/codesign-macos-folder.sh apps/desktop/resources/agent-browser/darwin-arm64 "$identity"',
    );
    const build = names.indexOf("Build, sign and notarize");
    const dry = names.indexOf("Build unsigned dry run");
    for (const name of [fetch?.name, sign?.name]) {
      expect(names.indexOf(name ?? "")).toBeGreaterThan(-1);
      expect(names.indexOf(name ?? "")).toBeLessThan(build);
      expect(names.indexOf(name ?? "")).toBeLessThan(dry);
    }
    expect(check?.run).toContain("agent-browser/agent-browser");
    expect(check?.run).toContain("Helpers/agent-desktop/agent-desktop");
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
    const builds = steps.filter((step) => step.run?.includes("bun run package --prebuilt"));
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
