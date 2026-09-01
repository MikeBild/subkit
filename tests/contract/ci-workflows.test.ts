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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

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

// ---------------------------------------------------------------------------
// Does this job need a browser? Derived, not commented.
//
// The requirement used to be a sentence about ONE job: "the konvention job
// installs a browser". It was true, it stayed true, and it was worthless the
// day `bun run test:contract` — a step in a DIFFERENT job — grew two files that
// drive Chromium. A comment cannot notice that. This can:
//
//   1. every `run:` step of every job yields its entry paths (a token that
//      names a real file or directory, after `bun run <script>` has been
//      resolved through package.json — recursively, because gate stages chain),
//   2. a directory entry expands to the test files a runner would execute,
//   3. every entry file is read, its COMMENTS ARE STRIPPED FIRST (a file that
//      merely names playwright in prose must not put itself on the list), and
//      its specifiers are collected in all four forms this repo writes them,
//   4. relative specifiers are resolved and followed transitively,
//   5. a bare specifier resolving to one of the browser packages makes the job
//      one that must install a browser before its first entry-bearing step.
//
// The mechanism is COPIED from WikiKit's test of the same name rather than
// imported — §7: patterns travel as copies across the family.
// ---------------------------------------------------------------------------

const BROWSER_PACKAGES = new Set(["playwright", "playwright-core", "puppeteer", "puppeteer-core"]);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"];
const TEST_FILE = /\.test\.(ts|tsx)$/;

/**
 * Source with its comments and regex literals removed.
 *
 * Naive stripping is not an option here: half the entry files are ABOUT
 * browsers and say so at length, and `readFileSync(…).includes("playwright")`
 * would mark every one of them.
 *
 * Regex literals have to be skipped too, and finding that out cost a round:
 * THIS file's own specifier pattern ends in a character class holding a
 * backtick. Read as a template string, that backtick opened a string state that
 * ran for twenty-two lines and carried the comments after it through
 * unstripped — so the guard put itself on the list of files that need a
 * browser, for a sentence in its own prose. Telling a regex from a division is
 * the usual heuristic: what may precede a regex is an operator, a bracket or a
 * keyword, never a value.
 */
const BEFORE_A_REGEX = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const KEYWORD_BEFORE_A_REGEX =
  /\b(return|typeof|instanceof|in|of|case|new|delete|void|do|else|yield|await)$/;

function stripComments(source: string): string {
  let out = "";
  let index = 0;
  // The last thing that was code, so a `/` can be read as regex or division.
  let previous = "";
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === char) break;
        else index += 1;
      }
      index += 1;
      out += source.slice(start, index);
      previous = out.trimEnd();
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/"))
        index += 1;
      index += 2;
      continue;
    }
    if (char === "/" && startsARegex(previous)) {
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index] as string;
        if (inner === "\\") index += 2;
        else if (inner === "[") {
          inClass = true;
          index += 1;
        } else if (inner === "]") {
          inClass = false;
          index += 1;
        } else if (inner === "/" && !inClass) break;
        else if (inner === "\n") break;
        else index += 1;
      }
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index] as string)) index += 1;
      out += " ";
      continue;
    }
    out += char;
    index += 1;
    if (!/\s/.test(char)) previous = out;
  }
  return out;
}

function startsARegex(previous: string): boolean {
  const trimmed = previous.trimEnd();
  if (trimmed.length === 0) return true;
  const last = trimmed[trimmed.length - 1] as string;
  return BEFORE_A_REGEX.has(last) || KEYWORD_BEFORE_A_REGEX.test(trimmed);
}

/**
 * Every module specifier in a source file, in all four forms.
 *
 * `from "x"` (static and re-export), `import "x"` (side effect), `import("x")`
 * (dynamic) and `require("x")`. A dynamic import whose specifier is held in a
 * variable is invisible to this — deliberately so: `tests/e2e` builds one that
 * way precisely so the suite runs on a host without a browser.
 */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g;

function specifiersOf(source: string): string[] {
  return [...stripComments(source).matchAll(SPECIFIER)].map((match) => match[1] as string);
}

/** Read once. The shard job's entry paths alone expand to some 1,400 files. */
const specifierCache = new Map<string, string[]>();

function specifiersOfFile(file: string): string[] {
  const cached = specifierCache.get(file);
  if (cached) return cached;
  let found: string[] = [];
  try {
    found = specifiersOf(readFileSync(join(root, file), "utf8"));
  } catch {
    found = [];
  }
  specifierCache.set(file, found);
  return found;
}

/** The package a bare specifier belongs to — `@scope/name` counts as one. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

function browserPackagesIn(source: string): string[] {
  return [
    ...new Set(
      specifiersOf(source)
        .filter((specifier) => !specifier.startsWith("."))
        .map(packageOf)
        .filter((name) => BROWSER_PACKAGES.has(name)),
    ),
  ].sort();
}

/**
 * A relative specifier as a repo-relative path, or null when it resolves to
 * nothing this walk should read.
 *
 * Only SOURCE files. The engine imports `docs/llms-full.txt` as a bundled
 * asset, and following that led the walk into a documentation blob whose code
 * samples say `import("playwright")` — which made the shard job look like it
 * needed a browser because a manual page mentions one.
 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(root, dirname(fromFile), specifier);
  const candidates = [
    ...(SOURCE_EXTENSIONS.some((extension) => base.endsWith(extension)) ? [base] : []),
    ...SOURCE_EXTENSIONS.map((extension) => base + extension),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate);
  }
  return null;
}

/** The test files a runner would execute under a directory. */
function testFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const item of readdirSync(join(root, current), { withFileTypes: true })) {
      if (item.name === "node_modules" || item.name.startsWith(".")) continue;
      const child = join(current, item.name);
      if (item.isDirectory()) walk(child);
      else if (TEST_FILE.test(item.name)) found.push(child);
    }
  };
  walk(directory);
  return found;
}

/**
 * The entry paths a single `run:` step actually hands to a runner.
 *
 * Only `bun test` and `bun run` are read. Everything else — biome, docker,
 * apt-get — takes no entry files, and reading their arguments is how `bun run
 * lint` ("biome check .") would put the whole repository into every job.
 */
function entryPathsIn(command: string, seen = new Set<string>()): string[] {
  const paths: string[] = [];
  for (const part of command.split(/&&|\|\||[;\n|]/)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] !== "bun") continue;
    if (tokens[1] === "test") {
      paths.push(...tokens.slice(2).filter(isEntryPath));
      continue;
    }
    if (tokens[1] !== "run") continue;
    const target = tokens[2];
    if (!target) continue;
    if (isEntryPath(target)) {
      paths.push(target, ...tokens.slice(3).filter(isEntryPath));
      continue;
    }
    // A gate stage: recurse into what it runs. `verify` chains twenty of them.
    const body = pkg.scripts[target];
    if (body !== undefined && !seen.has(target)) {
      seen.add(target);
      paths.push(...entryPathsIn(body, seen));
    }
  }
  return paths;
}

function isEntryPath(token: string): boolean {
  if (token.startsWith("-") || token === "." || token.includes("$")) return false;
  const full = join(root, token);
  return existsSync(full);
}

/** Every file reachable from these entry paths, and every package they name. */
const reachCache = new Map<string, { files: string[]; packages: Set<string> }>();

function reachableFrom(entries: readonly string[]): { files: string[]; packages: Set<string> } {
  const key = [...entries].sort().join("\0");
  const cached = reachCache.get(key);
  if (cached) return cached;
  const queue: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) queue.push(...testFilesUnder(entry));
    else queue.push(entry);
  }
  const visited = new Set<string>();
  const packages = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of specifiersOfFile(file)) {
      if (specifier.startsWith(".")) {
        const target = resolveRelative(file, specifier);
        if (target !== null && !visited.has(target)) queue.push(target);
      } else packages.add(packageOf(specifier));
    }
  }
  const result = { files: [...visited], packages };
  reachCache.set(key, result);
  return result;
}

/** The browser packages a single `run:` step can reach. */
function browsersReachedBy(command: string): string[] {
  const reach = reachableFrom(entryPathsIn(command));
  return [...reach.packages].filter((name) => BROWSER_PACKAGES.has(name)).sort();
}

/**
 * What the import walk is allowed to cost — stated, not inherited.
 *
 * These three tests read every file reachable from the entry points of the CI
 * jobs, which is most of the repository. Bun's default budget for a test is
 * 5 s, and this file hit that wall twice on this machine (5130 ms, 7629 ms)
 * without having changed: the walk is I/O over a few hundred files and its cost
 * is the disk's mood, not the repository's size. A runner's disk is colder.
 *
 * A budget that a healthy run exceeds is not a measurement of anything — it
 * reports "too slow" for a test that found nothing wrong, which is how a
 * mandatory stage gets muted.
 */
const WALK_BUDGET_MS = 30_000;

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

  // BEFUND-GATE-IST-NICHT-CI, second instance. `audit:invariants` DID run in a
  // workflow — `audit-invariants.yml`, on `pull_request` and `schedule`. So
  // the test above was green while the check covered the review path and not
  // the push path: a direct push to main ran no invariant at all, and the
  // `build` aggregate branch protection requires could not see the workflow
  // that did. "Runs somewhere" is not the property worth holding; "runs on the
  // path a commit actually takes, and blocks" is.
  test("audit:invariants runs in ci.yml on the push path and blocks the aggregate", () => {
    expect(verifyStages()).toContain("audit:invariants");
    expect(runs(job(ci, "invariants"))).toContain("bun run audit:invariants");
    // ci.yml's own triggers are pinned by the first test in this block; what
    // matters here is that the invariants job is inside THAT workflow and is a
    // prerequisite of the required check.
    expect(job(ci, "build").needs ?? []).toContain("invariants");
  });

  // ---------------------------------------------------------------------
  // The browser requirement, DERIVED — see the block above BROWSER_PACKAGES.
  // ---------------------------------------------------------------------

  // The reader has to see a specifier in every form the repo writes one, and it
  // must not see the ones that are only being TALKED about. This file is the
  // hardest case of the second kind: its own prose says "playwright" a dozen
  // times, so without stripping comments first it would put itself on the list
  // of files that need a browser — and the rule would be green on a machine
  // where nothing works.
  test("the reader sees every specifier form, and none that is only mentioned", () => {
    // The quotes are spliced in rather than typed. A fixture that spells out
    // `from "playwright"` IS an import as far as any reader is concerned — this
    // file sits inside tests/contract, so the fixture would put the quality job
    // on the list for a reason that only exists in a test.
    const q = '"';
    const source = [
      `import { chromium } from ${q}playwright${q};`,
      `import defaultExport from ${q}playwright-core${q};`,
      `export { thing } from ${q}./relative.ts${q};`,
      `import ${q}side-effect-only${q};`,
      `const late = await import(${q}puppeteer${q});`,
      `const older = require(${q}puppeteer-core${q});`,
      `// import { nope } from ${q}commented-out${q};`,
      `/* import { alsoNope } from ${q}block-commented${q}; */`,
      `const url = ${q}https://playwright.dev/docs${q};`,
    ].join("\n");
    expect(specifiersOf(source).sort()).toEqual(
      [
        "./relative.ts",
        "playwright",
        "playwright-core",
        "puppeteer",
        "puppeteer-core",
        "side-effect-only",
      ].sort(),
    );

    // A regex literal whose character class holds a quote. Read as a string,
    // it swallows everything after it and the comment below survives — which is
    // exactly how this file first put itself on the list.
    const withRegex = [
      `const pattern = /["'${"`"}]/g;`,
      `// import { hidden } from ${q}puppeteer${q};`,
      `import { real } from ${q}./neighbour.ts${q};`,
    ].join("\n");
    expect(specifiersOf(withRegex)).toEqual(["./neighbour.ts"]);

    const own = readFileSync(join(root, "tests/contract/ci-workflows.test.ts"), "utf8");
    expect(own, "this file names the packages in prose").toContain("playwright-core");
    expect(browserPackagesIn(own), "…and must not thereby demand a browser").toEqual([]);
  });

  // The walk is transitive or it is a directory listing. `scripts/lib/
  // cockpit-identity.mjs` is reachable from tests/contract ONLY through a
  // relative import inside cockpit-identity.test.ts, so it is the landmark that
  // separates "followed the imports" from "read the entry files".
  test(
    "the walk follows relative imports out of the entry files",
    () => {
      const reached = reachableFrom(["tests/contract"]);
      expect(reached.files).toContain("tests/contract/cockpit-identity.test.ts");
      expect(reached.files).toContain("scripts/lib/cockpit-identity.mjs");
      expect([...reached.packages].filter((name) => BROWSER_PACKAGES.has(name))).toEqual([
        "playwright",
      ]);
    },
    WALK_BUDGET_MS,
  );

  // THE ASSERTION THE RED BUILD WAS ABOUT.
  //
  // Playwright's browser binaries are not in node_modules — `bun install`
  // brings the library and there is no postinstall that fetches Chromium. The
  // konvention job knew that; the quality job did not, and `bun run
  // test:contract` had quietly acquired two browser-driven files. The stage
  // went red for a reason that has nothing to do with what it measures, which
  // is how a mandatory stage gets muted — and worse, a failing `beforeAll`
  // takes its whole describe with it, so CI executed 46 of 62 contract tests
  // and reported a launch error instead of the 16 it never ran.
  //
  // The old shape of this test named ONE job and could not have caught that.
  // The requirement is now derived: every job, every entry file its steps
  // actually run, everything those reach through relative imports.
  test(
    "every job that can reach a browser package installs one first",
    () => {
      const needing: string[] = [];
      for (const [name, entry] of Object.entries(ci.jobs ?? {})) {
        const commands = (entry.steps ?? []).map((step) => step.run ?? "");
        const needy = commands
          .map((command, index) => ({ index, browsers: browsersReachedBy(command) }))
          .filter((step) => step.browsers.length > 0);
        if (needy.length === 0) continue;
        needing.push(name);

        const first = needy[0] as { index: number; browsers: string[] };
        const install = commands.findIndex((command) => /playwright install/.test(command));
        expect(
          install,
          `job '${name}' reaches ${first.browsers.join(", ")} but never installs a browser`,
        ).toBeGreaterThanOrEqual(0);
        expect(commands[install]).toContain("chromium");
        // ubuntu-24.04 does not carry Chromium's system libraries.
        expect(commands[install]).toContain("--with-deps");
        // Before the step that needs it, not merely somewhere in the job.
        expect(
          install,
          `job '${name}' installs the browser after '${commands[first.index]}' has already asked for one`,
        ).toBeLessThan(first.index);
      }
      // Exact, not `length > 0`: a reader that silently stopped finding anything
      // would make every assertion in the loop above vacuous, which is the
      // failure mode this whole file exists against.
      expect(needing.sort()).toEqual(["konvention", "quality"]);
    },
    WALK_BUDGET_MS,
  );

  /**
   * THE CHEAP HALF OF THE PROOF — the derivation above says a job REACHES a
   * browser package; this says that reaching it means needing a BINARY.
   *
   * The expensive way to know that is the one that found the red build: empty
   * the browser cache, run the stage, then `playwright install` to put the
   * cache back. It measured 41 pass / 8 fail — 49 of 65 — and then 65 / 0 into
   * the same cache. It is also 95 MB over the network, and 95 MB before every
   * commit does not belong in a mandatory gate; a stage nobody can afford to
   * run is a stage that gets skipped, which is the failure this file exists
   * against.
   *
   * So the cache is not emptied — it is not consulted. `PLAYWRIGHT_BROWSERS_PATH`
   * pointed at a fresh empty directory is the same world as a runner that never
   * installed anything, minus the download: the failure is EXPECTED and nothing
   * is fetched to recover from it. Measured at 208 ms, and the directory is
   * still empty afterwards.
   *
   * What it pins is the shape of the red build, not just its exit code: ONE
   * failing hook takes the whole file with it, so the run reports a launch
   * error instead of the tests it never ran.
   */
  test("a browser-driven contract file goes red when no browser is installed", async () => {
    // mkdtemp, not a name built from a clock: several sessions of this family
    // run at once and a shared temp name measures whoever got there first.
    const noBrowsers = mkdtempSync(join(tmpdir(), "sk-no-browser-"));
    try {
      const run = Bun.spawn(["bun", "test", "tests/contract/cockpit-identity.test.ts"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: root,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: noBrowsers },
      });
      const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
      const exitCode = await run.exited;
      expect(exitCode, output).not.toBe(0);
      // Playwright's own words for "the library is here, the binary is not" —
      // which is exactly what `bun install` leaves behind.
      expect(output).toContain("playwright install");
      // NOTHING WAS DOWNLOADED. If this ever stops holding, the stage has
      // quietly become the 95 MB one.
      expect(readdirSync(noBrowsers)).toEqual([]);
    } finally {
      rmSync(noBrowsers, { recursive: true, force: true });
    }
  }, 120_000);

  // The honest edge of the derivation. An entry path is a token that names a
  // real file or directory in the run command; a runner that hard-codes the
  // directory it scans (scripts/test-e2e-isolated.ts scans tests/e2e itself)
  // therefore hides its test files from the walk. It costs nothing today —
  // tests/e2e reaches playwright only through a dynamic specifier held in a
  // variable, deliberately, so the suite runs on a host without a browser — and
  // the quality job installs one anyway. Recorded rather than papered over: if
  // that ever changes, this expectation is the thing that has to be revisited.
  test(
    "a runner that hides its own test files is a known blind spot",
    () => {
      const hidden = reachableFrom(["scripts/test-e2e-isolated.ts"]);
      expect(hidden.files).toContain("scripts/test-e2e-isolated.ts");
      expect(hidden.files.some((file) => file.startsWith("tests/e2e/"))).toBe(false);
      const suites = reachableFrom(["tests/e2e"]);
      expect([...suites.packages].filter((pkg) => BROWSER_PACKAGES.has(pkg))).toEqual([]);
    },
    WALK_BUDGET_MS,
  );

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

  test("release Docker smoke supplies the required stateless bootstrap key", () => {
    const smoke = job(release, "docker-build").steps?.find(
      (step) => step.name === "Smoke image with external PostgreSQL, health and readiness",
    );
    expect(smoke, "release Docker smoke step exists").toBeDefined();
    expect(smoke?.run).toContain("docker compose");
    expect(smoke?.env?.MASTER_KEY).toMatch(/^[0-9a-f]{64}$/);
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
