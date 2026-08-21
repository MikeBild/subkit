// The coupling between the local gate (`bun run verify`) and the workflows.
//
// WHY THIS FILE EXISTS
//
// `konvention:check` was added to `verify` and would have reached exactly
// nobody: SubKit's ci.yml does not call `verify`, it enumerates the stages as
// its own steps and jobs. A stage that lives only in `verify` is enforced on
// the machines of people who remember to type it. The same shape had already
// produced the finding this round started from — a check that exists, is never
// asked, and therefore is a comment.
//
// A comment cannot fail. This can.
//
// The mechanism is COPIED from WatchKit's test of the same name (which took it
// from WikiKit's) rather than imported: §7's rule for the family is that
// patterns travel as copies, and a shared helper across six repositories would
// be a seventh thing to keep in sync. What is SubKit's own here is the source
// of truth — WatchKit reads its stage ids out of `scripts/gate.ts`; SubKit has
// no gate.ts, its gate IS the `verify` chain in package.json, so the stages are
// read from there.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

type Step = { uses?: string; run?: string; name?: string; env?: Record<string, unknown> };
type Job = { needs?: string[]; steps?: Step[] };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

/** Bun parses YAML natively — no dependency to declare, and none to keep pinned. */
function load(file: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(root, ".github/workflows", file), "utf8")) as Workflow;
}

// Read the directory rather than listing the files: a workflow added later is
// covered by the reverse-direction test below without anybody remembering it.
const WORKFLOW_FILES = readdirSync(join(root, ".github/workflows")).filter((file) =>
  file.endsWith(".yml"),
);

const ci = load("ci.yml");
const release = load("release.yml");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function job(workflow: Workflow, name: string): Job {
  const found = workflow.jobs?.[name];
  if (!found) throw new Error(`expected job '${name}' to exist`);
  return found;
}

function runs(from: Job): string[] {
  return (from.steps ?? []).map((step) => step.run ?? "");
}

// `bun run <name>` — but not `bun run scripts/foo.ts`, which is a path and not
// a script name. The negative lookahead is what keeps "scripts" out of the
// stage list.
const SCRIPT_CALL = /\bbun run ([a-z][a-z0-9:-]*)(?![a-z0-9:./-])/g;

/**
 * The gate's stages, read out of the gate rather than typed here.
 *
 * Typed, this test would hold two hand-written lists against each other and
 * pass while both drifted away from the chain that actually runs. Derived, the
 * only way to change the expectation is to change `verify` — which is the event
 * this test exists to notice.
 */
function verifyStages(): string[] {
  const chain = pkg.scripts.verify;
  if (!chain) throw new Error("package.json has no `verify` script");
  const stages = [...new Set([...chain.matchAll(SCRIPT_CALL)].map((match) => match[1] as string))];
  // A regex that silently matched nothing would make every assertion below
  // vacuously true — the exact failure mode this file is written against.
  expect(stages.length, "verify stages must be readable").toBeGreaterThan(10);
  return stages;
}

/** Every `bun run <name>` any workflow actually executes, mapped to where. */
function scriptsInWorkflows(): Map<string, string> {
  const seen = new Map<string, string>();
  for (const file of WORKFLOW_FILES) {
    const workflow = load(file);
    for (const [jobName, entry] of Object.entries(workflow.jobs ?? {})) {
      for (const command of runs(entry)) {
        for (const match of command.matchAll(SCRIPT_CALL)) {
          const name = match[1] as string;
          if (!seen.has(name)) seen.set(name, `${file} / ${jobName}`);
        }
      }
    }
  }
  expect(seen.size, "workflow script calls must be readable").toBeGreaterThan(5);
  return seen;
}

/**
 * Gate stages that no workflow invokes BY NAME, each with the reason.
 *
 * This list is the honest part of the test. It is not permission to drift: the
 * assertion below holds it as an exact set, so a new gate stage that nobody
 * wired into a workflow fails here, and a gap that gets closed has to be
 * deleted from this list before the suite goes green again.
 *
 * The five drift checks are a real, pre-existing hole — they regenerate a
 * committed artifact and fail on a diff, they cost seconds, and CI simply never
 * got them. Recorded as LOCAL-SK-DRIFTCHECKS-NICHT-IN-CI; not closed here
 * because widening ci.yml's step list is a separate decision from this stage.
 */
const ONLY_IN_THE_LOCAL_GATE: Record<string, string> = {
  "check:settings-doc-drift": "no CI step — open gap (LOCAL-SK-DRIFTCHECKS-NICHT-IN-CI)",
  "check:slash-doc-drift": "no CI step — open gap (LOCAL-SK-DRIFTCHECKS-NICHT-IN-CI)",
  "check:config-example-drift": "no CI step — open gap (LOCAL-SK-DRIFTCHECKS-NICHT-IN-CI)",
  "check:embedded-drift": "no CI step — open gap (LOCAL-SK-DRIFTCHECKS-NICHT-IN-CI)",
  "check:catalog-drift": "no CI step — open gap (LOCAL-SK-DRIFTCHECKS-NICHT-IN-CI)",
  // Covered in substance, not by name: `test:e2e` is `build:sk` plus
  // scripts/test-e2e-isolated.ts, and ci.yml's quality job runs `build:all`
  // followed by that exact script.
  "test:e2e": "ci.yml ruft scripts/test-e2e-isolated.ts direkt, nach build:all",
};

describe("gate and workflows", () => {
  test("ci.yml triggers on push to main and on pull requests", () => {
    const on = ci.on as { push: { branches: string[] }; pull_request?: unknown };
    expect(on.push.branches).toEqual(["main"]);
    expect("pull_request" in on).toBe(true);
  });

  // THE ASSERTION THIS FILE WAS WRITTEN FOR.
  //
  // Remove a stage from `verify` and leave the workflows alone, or add one to
  // `verify` and forget the workflow, and this fails. `bun run verify` stops
  // meaning "CI will pass" the moment the two lists diverge silently.
  test("every gate stage runs in a workflow, or is named in the exception list", () => {
    const stages = verifyStages();
    const inWorkflows = scriptsInWorkflows();
    const missing = stages.filter((stage) => !inWorkflows.has(stage)).sort();
    expect(missing).toEqual(Object.keys(ONLY_IN_THE_LOCAL_GATE).sort());
    // And the other direction: an entry that is no longer a gate stage must not
    // sit here pretending to excuse something.
    for (const name of Object.keys(ONLY_IN_THE_LOCAL_GATE)) {
      expect(stages, `'${name}' is in the exception list but is no longer a gate stage`).toContain(
        name,
      );
    }
  });

  test("konvention:check is a gate stage AND a CI job", () => {
    expect(verifyStages()).toContain("konvention:check");
    expect(runs(job(ci, "konvention"))).toContain("bun run konvention:check");
  });

  // The convention check is the only job that opens a browser, and playwright's
  // browser binaries are not in node_modules — `bun install` brings the library
  // and not Chromium, and there is no postinstall that fetches it. Without this
  // step the stage is red for a reason that has nothing to do with the
  // convention, and a mandatory stage that is red for the wrong reason is how a
  // stage gets muted.
  test("the konvention job installs a browser before it needs one", () => {
    const steps = runs(job(ci, "konvention"));
    const install = steps.findIndex((step) => /playwright install/.test(step));
    const check = steps.findIndex((step) => step === "bun run konvention:check");
    expect(install, "the konvention job must install playwright browsers").toBeGreaterThanOrEqual(
      0,
    );
    expect(steps[install]).toContain("chromium");
    // ubuntu-24.04 does not carry Chromium's system libraries.
    expect(steps[install]).toContain("--with-deps");
    expect(install).toBeLessThan(check);
  });

  // A green "build" signal must not be reachable past a red check — and "past"
  // includes the check that was added last, which is the one a `needs` list is
  // most likely to have missed. `build` is the required status check on main,
  // so a job outside its `needs` is a job nothing waits for.
  test("the build aggregate depends on EVERY other job and checks every result", () => {
    const others = Object.keys(ci.jobs ?? {}).filter((name) => name !== "build");
    const aggregate = job(ci, "build");
    expect((aggregate.needs ?? []).sort()).toEqual(others.sort());
    // `needs` alone only orders the jobs; with `if: always()` the aggregate
    // still runs when one of them failed, so every result must be asserted in
    // the step body too.
    const body = runs(aggregate).join("\n");
    for (const name of others) {
      const variable = `${name.replace(/-.*/, "").toUpperCase()}_RESULT`;
      expect(body, `build checks the result of '${name}' (${variable})`).toContain(variable);
    }
  });

  // The release path. SubKit does not repeat the stages in release.yml — its
  // gate job requires a green ci.yml run on the release SHA. That is what makes
  // a stage added to ci.yml also a stage the release cannot skip, so the
  // dependency is asserted rather than assumed.
  test("release.yml only gets past a green ci.yml", () => {
    const gate = runs(job(release, "gate")).join("\n");
    expect(gate).toContain("--workflow ci.yml");
    expect(gate).toContain('--commit "$SHA"');
    for (const name of ["build-cli-binaries", "docker-publish"]) {
      expect(job(release, name).needs ?? [], `${name} depends on the gate`).toContain("gate");
    }
  });

  // The seam is real: the gate invokes package.json script NAMES, and so do the
  // workflows — but they are two hand-maintained lists. A renamed or deleted
  // script fails CI with "Script not found" while the local gate stays green.
  test("jedes `bun run <script>` in einem Workflow existiert in package.json", () => {
    for (const [name, where] of scriptsInWorkflows()) {
      expect(
        pkg.scripts[name],
        `${where} calls \`bun run ${name}\`, which package.json does not define`,
      ).toBeDefined();
    }
  });

  test("every job using bun installs with a frozen lockfile via setup-bun", () => {
    for (const [name, entry] of Object.entries(ci.jobs ?? {})) {
      const commands = runs(entry);
      if (!commands.some((command) => command.includes("bun "))) continue;
      const uses = (entry.steps ?? []).map((step) => step.uses ?? "");
      expect(
        uses.some((used) => used.startsWith("oven-sh/setup-bun@")),
        `${name} benutzt setup-bun`,
      ).toBe(true);
      expect(commands, `${name} installiert frozen`).toContain("bun install --frozen-lockfile");
    }
  });
});
