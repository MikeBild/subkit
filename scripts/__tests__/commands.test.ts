import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONCERNS,
  DESKTOP_MUTATION_SCOPES,
  GATE,
  gateFor,
  MANUAL_CHECKS,
  PROFILES,
  parseArgs,
  plan,
  type Step,
} from "../lib/commands.ts";

const ROOT = join(import.meta.dir, "..", "..");
const LINUX = { version: "1.2.3", platform: "linux" };
const MAC = { version: "1.2.3", platform: "darwin" };

function steps(concern: string, argv: string[], ctx = LINUX): readonly Step[] {
  const result = plan(concern, argv, ctx);
  if (!result.ok) throw new Error(result.usage);
  return result.steps;
}

const commands = (list: readonly Step[]) => list.map((step) => step.argv.join(" "));

const WORDS: Readonly<Record<string, string>> = {
  "quality prune": "coverage",
  "quality benchmark": "smoke",
};

function everyPlan(): Step[] {
  const all: Step[] = [];
  for (const [concern, subs] of Object.entries(CONCERNS))
    for (const sub of Object.keys(subs)) {
      const word = WORDS[`${concern} ${sub}`];
      all.push(...steps(concern, word ? [sub, word] : [sub]));
    }
  for (const profile of PROFILES) all.push(...steps("verify", [profile]));
  for (const check of MANUAL_CHECKS) all.push(...steps("verify", [check.id]));
  return all;
}

describe("parseArgs", () => {
  test("takes the first word as the subcommand and keeps the rest in order", () => {
    expect(parseArgs(["bump", "11.4.0"])).toMatchObject({ sub: "bump", rest: ["11.4.0"] });
    expect(parseArgs(["release-notes", "--release", "v1.0.0", "--check"])).toMatchObject({
      sub: "release-notes",
      rest: ["--release", "v1.0.0"],
    });
    expect(parseArgs(["--mock"])).toMatchObject({ sub: undefined, rest: ["--mock"] });
  });

  test("drops a bare -- and reads value options", () => {
    const args = parseArgs(["engine", "--", "--outfile", "/out/engine", "--skip-deps"]);
    expect(args.options.get("--outfile")).toBe("/out/engine");
    expect(args.flags.has("--skip-deps")).toBe(true);
    expect(args.rest).toEqual([]);
  });
});

describe("plan", () => {
  test("every script a step runs exists", () => {
    const files = everyPlan().flatMap((step) =>
      step.argv
        .slice(1)
        .filter((arg) => /\.(ts|sh)$/.test(arg) && !arg.startsWith("-"))
        .map((file) => join(ROOT, step.cwd ?? "", file)),
    );
    expect(files.length).toBeGreaterThan(30);
    expect(files.filter((file) => !existsSync(file))).toEqual([]);
  });

  test("an unknown command or subcommand answers with its usage", () => {
    const unknown = plan("ship", [], LINUX);
    expect(unknown.ok).toBe(false);
    const sub = plan("gen", ["nothing"], LINUX);
    expect(!sub.ok && sub.usage).toContain("usage: bun run gen <icons|config");
    const check = plan("verify", ["help"], LINUX);
    expect(!check.ok && check.usage).toContain("profiles:");
  });

  test("hands extra arguments to the last step", () => {
    expect(commands(steps("release", ["bump", "11.4.0"]))).toEqual([
      "bun scripts/bump-version.ts 11.4.0",
    ]);
    expect(commands(steps("verify", ["llm-live", "--", "--models", "openai:a"]))).toEqual([
      "bun scripts/verify-llm-live.ts --models openai:a",
    ]);
    expect(commands(steps("gen", ["release-notes", "--release", "v1.0.0"]))).toEqual([
      "bun scripts/gen-release-notes.ts --release v1.0.0",
    ]);
  });

  test("a drift check regenerates, then fails on a diff or asks the generator", () => {
    expect(commands(steps("gen", ["openapi", "--check"]))).toEqual([
      "bun scripts/gen-openapi-client.ts",
      "git diff --exit-code -- packages/cli-core/src/engine-api",
    ]);
    expect(commands(steps("gen", ["sandbox", "--check"]))).toEqual([
      "bun scripts/gen-sandbox-tools.ts --check",
    ]);
    const config = steps("gen", ["config"]);
    expect(config[0]?.stdout).toBe("subkit.config.example.json");
  });

  test("builds the engine for another target without signing it", () => {
    const linux = commands(steps("build", ["engine", "--skip-deps", "--target", "linux-x64"], MAC));
    expect(linux).toHaveLength(1);
    expect(linux[0]).toContain("--target=bun-linux-x64");
    expect(linux[0]).toContain('--define BUILD_VERSION="1.2.3"');
    const host = commands(steps("build", ["engine", "--skip-deps"], MAC));
    expect(host.at(-1)).toBe("sh scripts/codesign-macos.sh dist/engine");
  });

  test("the engine build prepares clipper, cockpit and embedding assets first", () => {
    expect(steps("build", ["engine"]).map((step) => step.label)).toEqual([
      "build clipper",
      "gen icons",
      "build cockpit",
      "embed cockpit",
      "fetch embedding assets",
      "compile engine",
    ]);
  });

  test("runs every desktop mutation scope with its own config", () => {
    for (const scope of DESKTOP_MUTATION_SCOPES) {
      const [step] = steps("quality", ["mutation", scope]);
      const config = step?.argv.at(-1) ?? "";
      expect(config).toBe(`apps/desktop/stryker.${scope}.json`);
      expect(existsSync(join(ROOT, config))).toBe(true);
    }
    expect(commands(steps("quality", ["mutation"])).at(1)).toBe("bunx stryker run --force");
  });

  test("every desktop mutation config has its scope", () => {
    const configs = readdirSync(join(ROOT, "apps/desktop"))
      .map((name) => /^stryker\.(.+)\.json$/.exec(name)?.[1])
      .filter((scope): scope is string => Boolean(scope))
      .sort();
    expect([...DESKTOP_MUTATION_SCOPES].sort()).toEqual(configs);
  });

  test("prune previews unless asked to apply", () => {
    expect(commands(steps("quality", ["prune", "runs"]))).toEqual([
      "bun scripts/prune-verification-runs.ts --preview",
    ]);
    expect(commands(steps("quality", ["prune", "coverage", "--apply"]))).toEqual([
      "bun scripts/prune-coverage-runs.ts --apply",
    ]);
  });
});

describe("gate", () => {
  test("every check has a unique id and every profile is drawn from the one list", () => {
    const ids = [...GATE, ...MANUAL_CHECKS].map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const profile of PROFILES) {
      const order = gateFor(profile).map((check) => GATE.indexOf(check));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.length).toBeGreaterThan(0);
    }
  });

  test("the push profile is a subset of the static checks plus the binaries", () => {
    const fixed = new Set(gateFor("static").map((check) => check.id));
    const extra = gateFor("push").filter((check) => !fixed.has(check.id));
    expect(extra.map((check) => check.id)).toEqual(["build"]);
  });

  test("verify runs the full gate by default", () => {
    expect(commands(steps("verify", []))).toEqual(commands(steps("verify", ["full"])));
  });
});
