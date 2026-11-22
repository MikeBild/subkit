import {
  ENGINE_DESKTOP_TARGET_NAMES,
  selectEngineDesktopTargets,
} from "./engine-desktop-targets.ts";
import {
  DEFER_MUTATION_FLAG,
  type MutationEvidence,
  parseMutationDeferral,
} from "./mutation-deferral.ts";

export interface Step {
  readonly label: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stdout?: string;
}

export interface Context {
  readonly version: string;
  readonly platform: string;
}

export type Plan =
  | { readonly ok: true; readonly steps: readonly Step[] }
  | { readonly ok: false; readonly usage: string };

interface Args {
  readonly sub: string | undefined;
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
  readonly rest: readonly string[];
}

const VALUE_OPTIONS = new Set(["--outfile", "--metafile", "--target"]);
const KNOWN_FLAGS = new Set(["--check", "--apply", "--skip-deps"]);

export function parseArgs(argv: readonly string[]): Args {
  let sub: string | undefined;
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    if (VALUE_OPTIONS.has(arg) && i + 1 < argv.length) options.set(arg, argv[++i] ?? "");
    else if (KNOWN_FLAGS.has(arg)) flags.add(arg);
    else if (sub === undefined && rest.length === 0 && !arg.startsWith("-")) sub = arg;
    else rest.push(arg);
  }
  return { sub, flags, options, rest };
}

const step = (label: string, argv: readonly string[], extra: Partial<Step> = {}): Step => ({
  label,
  argv,
  ...extra,
});
const bun = (label: string, ...argv: string[]): Step => step(label, ["bun", ...argv]);
const diff = (label: string, ...paths: string[]): Step =>
  step(label, ["git", "diff", "--exit-code", "--", ...paths]);

export interface CompileInput {
  readonly entries: readonly string[];
  readonly version: string;
  readonly outfile: string;
  readonly metafile?: string;
  readonly target?: string;
  readonly root?: boolean;
}

export function compileCommand(input: CompileInput): string[] {
  return [
    "bun",
    "build",
    ...input.entries,
    "--compile",
    ...(input.root ? ["--root", "."] : []),
    "--external",
    "cpu-features",
    ...(input.target ? [`--target=${input.target}`] : []),
    "--define",
    "process.env.NODE_ENV=process.env.NODE_ENV",
    "--define",
    `BUILD_VERSION="${input.version}"`,
    ...(input.metafile ? [`--metafile=${input.metafile}`] : []),
    "--outfile",
    input.outfile,
  ];
}

export const ENGINE_ENTRIES = [
  "apps/engine/src/index.ts",
  "apps/engine/src/embeddings/embedding-worker.ts",
] as const;
export const SUBKIT_ENTRIES = ["apps/subkit/src/index.ts"] as const;

export function signOnMacos(ctx: Context, file: string): Step[] {
  return ctx.platform === "darwin"
    ? [step(`sign ${file}`, ["sh", "scripts/codesign-macos.sh", file])]
    : [];
}

const COCKPIT_ICONS = [
  "apps/cockpit/src/lib/service-icons.generated.ts",
  "apps/cockpit/src/lib/service-icon-marks.generated.ts",
];

interface Generator {
  readonly summary: string;
  readonly run: Step;
  readonly native?: boolean;
  readonly outputs?: readonly string[];
}

const GENERATORS: Readonly<Record<string, Generator>> = {
  icons: {
    summary: "service icons of the cockpit",
    run: bun("gen icons", "scripts/gen-cockpit-icons.ts"),
    outputs: COCKPIT_ICONS,
  },
  config: {
    summary: "subkit.config.example.json from the config schema",
    run: step("gen config", ["bun", "apps/engine/scripts/gen-config-example.ts"], {
      stdout: "subkit.config.example.json",
    }),
    outputs: ["subkit.config.example.json"],
  },
  llms: {
    summary: "llms.txt, reference docs and knowledge seeds",
    run: bun("gen llms", "scripts/gen-llms-txt.ts"),
    outputs: [
      "apps/engine/src/http/llms",
      "apps/engine/src/knowledge/seeds",
      "apps/engine/src/knowledge/embedded-seeds.ts",
      "apps/engine/src/http/docs-images-embedded.ts",
    ],
  },
  openapi: {
    summary: "OpenAPI client types in packages/cli-core",
    run: bun("gen openapi", "scripts/gen-openapi-client.ts"),
    outputs: ["packages/cli-core/src/engine-api"],
  },
  migrations: {
    summary: "embedded migrations of the engine",
    run: bun("gen migrations", "scripts/gen-embedded-migrations.ts"),
    outputs: ["apps/engine/src/db/migrations/embedded.ts"],
  },
  sandbox: {
    summary: "sandbox tool bundles",
    run: bun("gen sandbox", "scripts/gen-sandbox-tools.ts"),
    native: true,
  },
  "release-notes": {
    summary: "release notes of the cockpit",
    run: bun("gen release-notes", "scripts/gen-release-notes.ts"),
    native: true,
  },
};

function generate(name: string, check: boolean): Step[] {
  const gen = GENERATORS[name];
  if (!gen) return [];
  if (!check) return [gen.run];
  if (gen.native) return [{ ...gen.run, argv: [...gen.run.argv, "--check"] }];
  return [gen.run, diff(`${gen.run.label} --check`, ...(gen.outputs ?? []))];
}

function buildClipper(check: boolean): Step[] {
  return [bun("build clipper", "scripts/build-clipper.ts", ...(check ? ["--check"] : []))];
}

function buildCockpit(check: boolean): Step[] {
  return [
    GENERATORS.icons?.run as Step,
    step("build cockpit", ["bunx", "vite", "build", "--config", "apps/cockpit/vite.config.ts"], {
      env: { NODE_ENV: "production" },
    }),
    bun("embed cockpit", "scripts/gen-embedded-cockpit.ts"),
    ...(check ? [diff("build cockpit --check", ...COCKPIT_ICONS)] : []),
  ];
}

function buildAssets(): Step[] {
  return [
    ...buildClipper(false),
    ...buildCockpit(false),
    bun("fetch embedding assets", "scripts/fetch-embedding-assets.ts"),
  ];
}

function buildEngine(ctx: Context, args: Args): Step[] {
  const outfile = args.options.get("--outfile") ?? "dist/engine";
  const target = args.options.get("--target");
  return [
    ...(args.flags.has("--skip-deps") ? [] : buildAssets()),
    step(
      "compile engine",
      compileCommand({
        entries: ENGINE_ENTRIES,
        root: true,
        version: ctx.version,
        outfile,
        target: target ? `bun-${target.replace(/^bun-/, "")}` : undefined,
        metafile: args.options.get("--metafile"),
      }),
    ),
    ...(target || args.options.has("--outfile") ? [] : signOnMacos(ctx, outfile)),
  ];
}

function buildSk(ctx: Context, args: Args): Step[] {
  const outfile = args.options.get("--outfile") ?? "dist/subkit";
  return [
    ...(args.flags.has("--skip-deps") ? [] : buildClipper(false)),
    step(
      "compile subkit",
      compileCommand({
        entries: SUBKIT_ENTRIES,
        version: ctx.version,
        outfile,
        metafile: args.options.get("--metafile"),
      }),
    ),
    ...(args.options.has("--outfile") ? [] : signOnMacos(ctx, outfile)),
  ];
}

function buildDesktopEngine(args: Args): Step[] {
  const name = args.options.get("--target");
  if (!selectEngineDesktopTargets(name).ok) return [];
  const target = name === undefined ? [] : ["--target", name];
  return [
    ...(args.flags.has("--skip-deps") ? [] : buildAssets()),
    bun("compile desktop engines", "scripts/build-engine-desktop.ts", ...target),
    bun("desktop engine notices", "scripts/engine-desktop-notices.ts", ...target),
  ];
}

function testLayer(layer: string): Step {
  return bun(`test ${layer}`, "scripts/test-layer.ts", layer);
}

const SUBKIT_SMOKES = [
  "./tests/e2e/subkit-binary-settings.smoke.ts",
  "./tests/e2e/subkit-overhaul.smoke.ts",
];

function flake(): Step[] {
  return [1, 2, 3, 4, 5].map((seed) => ({
    ...testLayer("unit"),
    label: `test unit (seed ${seed})`,
    env: { SUBKIT_DETERMINISTIC_SEED: String(seed) },
  }));
}

export const PROFILES = ["push", "static", "full", "release"] as const;
export type Profile = (typeof PROFILES)[number];

export interface Check {
  readonly id: string;
  readonly summary: string;
  readonly profiles: readonly Profile[];
  readonly steps: (ctx: Context) => readonly Step[];
}

const P = "push" as const;
const S = "static" as const;
const F = "full" as const;
const R = "release" as const;

export const GATE: readonly Check[] = [
  {
    id: "mutation-evidence",
    summary: "passing release mutation evidence for this commit",
    profiles: [R],
    steps: () => [bun("mutation evidence", "scripts/release-mutation-evidence.ts", "check")],
  },
  {
    id: "bun-version",
    summary: "the Bun of .bun-version",
    profiles: [P, S, F, R],
    steps: () => [bun("bun version", "scripts/check-bun-version.ts")],
  },
  {
    id: "lint",
    summary: "biome",
    profiles: [P, S, F, R],
    steps: () => [step("lint", ["bunx", "biome", "check", "."])],
  },
  {
    id: "typecheck",
    summary: "tsc for every package",
    profiles: [P, S, F, R],
    steps: () => [step("typecheck", ["bash", "scripts/typecheck.sh"])],
  },
  {
    id: "recipes",
    summary: "connector recipes",
    profiles: [S, F, R],
    steps: () => [bun("recipes", "scripts/lint-recipes.ts")],
  },
  {
    id: "invariants",
    summary: "repository invariants and ratchets",
    profiles: [P, S, F, R],
    steps: () => [bun("invariants", "apps/engine/scripts/audit-invariants.ts")],
  },
  {
    id: "deps",
    summary: "no phantom dependencies",
    profiles: [S, F, R],
    steps: () => [bun("deps", "scripts/check-deps-phantom.ts")],
  },
  {
    id: "desktop",
    summary: "desktop install, unit tests and notices",
    profiles: [S, F, R],
    steps: () => [
      bun("desktop install", "install", "--frozen-lockfile", "--cwd", "apps/desktop"),
      step("desktop test", ["bun", "run", "test"], { cwd: "apps/desktop" }),
      step("desktop notices", ["bun", "run", "notices", "--check"], { cwd: "apps/desktop" }),
    ],
  },
  {
    id: "sandbox",
    summary: "sandbox bundles are current",
    profiles: [P, S, F, R],
    steps: () => generate("sandbox", true),
  },
  {
    id: "config",
    summary: "config example is current",
    profiles: [P, S, F, R],
    steps: () => generate("config", true),
  },
  {
    id: "migrations",
    summary: "embedded migrations are current",
    profiles: [P, S, F, R],
    steps: () => generate("migrations", true),
  },
  {
    id: "clipper",
    summary: "clipper archive is current",
    profiles: [S, F, R],
    steps: () => buildClipper(true),
  },
  {
    id: "cockpit",
    summary: "cockpit builds and its icons are current",
    profiles: [S, F, R],
    steps: () => buildCockpit(true),
  },
  {
    id: "release-notes",
    summary: "release notes are current",
    profiles: [S, F, R],
    steps: () => generate("release-notes", true),
  },
  {
    id: "llms",
    summary: "llms.txt and reference docs are current",
    profiles: [P, S, F, R],
    steps: () => generate("llms", true),
  },
  {
    id: "docs",
    summary: "end-user docs",
    profiles: [S, F, R],
    steps: () => [bun("docs", "scripts/check-docs.ts")],
  },
  {
    id: "openapi",
    summary: "OpenAPI client is current",
    profiles: [P, S, F, R],
    steps: () => generate("openapi", true),
  },
  {
    id: "contract",
    summary: "contract tests",
    profiles: [S, F, R],
    steps: () => [step("test contract", ["bun", "test", "tests/contract/"])],
  },
  {
    id: "determinism",
    summary: "no clock or randomness in tests",
    profiles: [P, S, F, R],
    steps: () => [bun("determinism", "scripts/check-determinism.ts")],
  },
  {
    id: "benchmark",
    summary: "runtime benchmark, smoke profile",
    profiles: [F],
    steps: () => benchmark("smoke"),
  },
  {
    id: "suite",
    summary: "every test file, isolated",
    profiles: [F],
    steps: () => [bun("test all", "scripts/test-files-isolated.ts", "apps", "packages", "scripts")],
  },
  {
    id: "eval",
    summary: "offline evals",
    profiles: [F],
    steps: () => [bun("eval", "apps/engine/eval/runner.ts")],
  },
  {
    id: "clipper-binaries",
    summary: "clipper inside the built binaries",
    profiles: [F],
    steps: (ctx) => [
      ...buildEngine(ctx, parseArgs([])),
      ...buildSk(ctx, parseArgs([])),
      bun("clipper binaries", "scripts/verify-clipper-binaries.ts"),
    ],
  },
  {
    id: "e2e",
    summary: "end-to-end tests against the built subkit",
    profiles: [F],
    steps: (ctx) => e2e(ctx),
  },
  {
    id: "coverage",
    summary: "coverage floor",
    profiles: [F, R],
    steps: () => [bun("coverage", "apps/engine/scripts/check-coverage-floor.ts")],
  },
  {
    id: "mutation",
    summary: "engine mutation floor",
    profiles: [F],
    steps: () => mutation("engine"),
  },
  {
    id: "docker",
    summary: "docker tests against a fresh image",
    profiles: [R],
    steps: () => [bun("test docker", "scripts/test-docker-isolated.ts")],
  },
  {
    id: "smoke",
    summary: "onboarding surfaces smoke",
    profiles: [R],
    steps: () => [bun("test smoke", "tests/e2e/onboarding-surfaces.smoke.ts")],
  },
  {
    id: "build",
    summary: "subkit and engine binaries",
    profiles: [P],
    steps: (ctx) => [...buildSk(ctx, parseArgs([])), ...buildEngine(ctx, parseArgs([]))],
  },
];

export const MANUAL_CHECKS: readonly Check[] = [
  {
    id: "llm-live",
    summary: "live model gate (paid)",
    profiles: [],
    steps: () => [bun("llm live", "scripts/verify-llm-live.ts")],
  },
  {
    id: "intake-live",
    summary: "intake against a running engine",
    profiles: [],
    steps: () => [bun("intake live", "scripts/verify-intake-live.ts")],
  },
  {
    id: "semgrep",
    summary: "Semgrep as the security workflow runs it",
    profiles: [],
    steps: () => [step("semgrep", ["bash", "scripts/semgrep.sh"])],
  },
  {
    id: "storage",
    summary: "object storage contract against a bucket",
    profiles: [],
    steps: () => [bun("storage", "scripts/check-object-storage-contract.ts")],
  },
];

export function gateFor(profile: Profile): readonly Check[] {
  return GATE.filter((check) => check.profiles.includes(profile));
}

function e2e(ctx: Context): Step[] {
  return [
    ...buildSk(ctx, parseArgs([])),
    testLayer("e2e"),
    step("test subkit smoke", ["bun", "test", ...SUBKIT_SMOKES]),
  ];
}

const BENCHMARKS: Readonly<Record<string, string>> = {
  smoke: "candidate.json",
  release: "release-candidate.json",
  full: "candidate.json",
};

function benchmark(profile: string): Step[] {
  const output = BENCHMARKS[profile];
  if (!output) return [];
  return [
    bun(
      `benchmark ${profile}`,
      "scripts/runtime-benchmark.ts",
      "capture",
      "--profile",
      profile,
      "--label",
      "candidate",
      "--source",
      ".",
      "--output",
      `.artifacts/runtime-benchmark/${output}`,
      "--require-helpers",
    ),
  ];
}

export const DESKTOP_MUTATION_SCOPES = [
  "computer",
  "browser",
  "live",
  "local",
  "kernel",
  "shell",
] as const;

function mutation(scope: string): Step[] {
  if (scope === "engine")
    return [
      bun("prepare mutation", "apps/engine/scripts/prepare-mutation-run.ts"),
      step("stryker", ["bunx", "stryker", "run", "--force"]),
      bun("mutation floor", "apps/engine/scripts/check-mutation-floor.ts"),
    ];
  if ((DESKTOP_MUTATION_SCOPES as readonly string[]).includes(scope))
    return [
      step(`stryker desktop ${scope}`, [
        "bunx",
        "stryker",
        "run",
        `apps/desktop/stryker.${scope}.json`,
      ]),
    ];
  return [];
}

interface Sub {
  readonly summary: string;
  readonly word?: true;
  readonly plan: (ctx: Context, args: Args, word: string) => readonly Step[];
}

type Concern = Readonly<Record<string, Sub>>;

const list = (values: readonly string[]): string => values.join("|");

const PRUNE: Readonly<Record<string, string>> = {
  coverage: "scripts/prune-coverage-runs.ts",
  mutation: "scripts/prune-mutation-runs.ts",
  runs: "scripts/prune-verification-runs.ts",
};

export const CONCERNS: Readonly<Record<string, Concern>> = {
  gen: {
    ...Object.fromEntries(
      Object.entries(GENERATORS).map(([name, gen]) => [
        name,
        {
          summary: gen.summary,
          plan: (_ctx: Context, args: Args) => generate(name, args.flags.has("--check")),
        },
      ]),
    ),
    all: {
      summary: "every generator in order",
      plan: (_ctx, args) =>
        Object.keys(GENERATORS).flatMap((name) => generate(name, args.flags.has("--check"))),
    },
  },
  build: {
    assets: { summary: "clipper, cockpit and embedding assets", plan: () => buildAssets() },
    clipper: {
      summary: "clipper archive [--check]",
      plan: (_ctx, args) => buildClipper(args.flags.has("--check")),
    },
    cockpit: {
      summary: "icons, cockpit bundle and its embed [--check]",
      plan: (_ctx, args) => buildCockpit(args.flags.has("--check")),
    },
    engine: {
      summary:
        "engine binary [--skip-deps] [--target <bun target>] [--outfile <f>] [--metafile <f>]",
      plan: (ctx, args) => buildEngine(ctx, args),
    },
    subkit: {
      summary: "subkit binary [--skip-deps] [--outfile <f>] [--metafile <f>]",
      plan: (ctx, args) => buildSk(ctx, args),
    },
    "desktop-engine": {
      summary: `engines for the desktop app and their notices [--skip-deps] [--target ${ENGINE_DESKTOP_TARGET_NAMES}]`,
      plan: (_ctx, args) => buildDesktopEngine(args),
    },
    all: {
      summary: "engine and subkit",
      plan: (ctx) => [
        ...buildEngine(ctx, parseArgs([])),
        ...buildSk(ctx, parseArgs(["--skip-deps"])),
      ],
    },
  },
  test: {
    unit: { summary: "unit layer", plan: () => [testLayer("unit")] },
    integration: { summary: "integration layer", plan: () => [testLayer("integration")] },
    regression: { summary: "regression layer", plan: () => [testLayer("regression")] },
    journey: { summary: "journey layer", plan: () => [testLayer("journey")] },
    e2e: {
      summary: "build subkit, then the e2e layer and the subkit smokes",
      plan: (ctx) => e2e(ctx),
    },
    docker: {
      summary: "docker tests against a fresh image",
      plan: () => [bun("test docker", "scripts/test-docker-isolated.ts")],
    },
    contract: {
      summary: "contract tests",
      plan: () => [step("test contract", ["bun", "test", "tests/contract/"])],
    },
    smoke: {
      summary: "onboarding surfaces smoke",
      plan: () => [bun("test smoke", "tests/e2e/onboarding-surfaces.smoke.ts")],
    },
    affected: {
      summary: "tests affected by a git range",
      plan: () => [bun("test affected", "scripts/affected-tests.ts")],
    },
    flake: { summary: "unit layer under five seeds", plan: () => flake() },
    core: {
      summary: "engine core tests",
      plan: () => [bun("test core", "apps/engine/scripts/run-core-tests.ts")],
    },
    all: {
      summary: "every test file, isolated",
      plan: () => [
        bun("test all", "scripts/test-files-isolated.ts", "apps", "packages", "scripts"),
      ],
    },
  },
  quality: {
    coverage: {
      summary: "coverage floor",
      plan: () => [bun("coverage", "apps/engine/scripts/check-coverage-floor.ts")],
    },
    mutation: {
      summary: `mutation run [engine|${list(DESKTOP_MUTATION_SCOPES)}], engine by default`,
      word: true,
      plan: (_ctx, _args, word) => mutation(word || "engine"),
    },
    release: {
      summary: "release mutation evidence for this commit [--check]",
      plan: (ctx, args) =>
        args.flags.has("--check")
          ? [bun("mutation evidence", "scripts/release-mutation-evidence.ts", "check")]
          : [
              ...buildAssets(),
              ...buildSk(ctx, parseArgs(["--skip-deps"])),
              bun("mutation evidence", "scripts/release-mutation-evidence.ts", "run"),
            ],
    },
    prune: {
      summary: "prune <coverage|mutation|runs> [--apply], a preview by default",
      word: true,
      plan: (_ctx, args, word) => {
        const file = PRUNE[word];
        if (!file) return [];
        return [bun(`prune ${word}`, file, args.flags.has("--apply") ? "--apply" : "--preview")];
      },
    },
    benchmark: {
      summary: `runtime benchmark <${list(Object.keys(BENCHMARKS))}>`,
      word: true,
      plan: (_ctx, _args, word) => benchmark(word),
    },
  },
  demo: {
    start: {
      summary: "start the cockpit demo [--mock]",
      plan: () => [bun("demo", "scripts/start-cockpit-demo.ts")],
    },
    ...Object.fromEntries(
      ["stop", "restart", "rebuild", "reset", "status", "key"].map((name) => [
        name,
        {
          summary: `${name} the cockpit demo`,
          plan: () => [bun(`demo ${name}`, "scripts/start-cockpit-demo.ts", `--${name}`)],
        },
      ]),
    ),
    verify: {
      summary: "check the running demo matches this checkout, then verify it",
      plan: () => [bun("demo verify", "scripts/verify-cockpit-local-demo.ts")],
    },
    lifecycle: {
      summary: "start, restart and reset the demo end to end",
      plan: () => [bun("demo lifecycle", "scripts/verify-cockpit-demo-lifecycle.ts")],
    },
  },
  release: {
    bump: {
      summary: "bump <version>: write the version everywhere",
      plan: () => [bun("bump", "scripts/bump-version.ts")],
    },
    deps: {
      summary: "report outdated dependencies and apply safe minor and patch updates [--check]",
      plan: (_ctx, args) => [
        bun("deps", "scripts/deps-update.ts", ...(args.flags.has("--check") ? ["--check"] : [])),
      ],
    },
    tag: {
      summary: "run the release gate and push the tag",
      plan: () => [bun("release tag", "scripts/tag-release.ts")],
    },
    verify: {
      summary: "verify a deployed engine --engine-url <url> --version <v>",
      plan: () => [bun("release verify", "scripts/verify-release.ts")],
    },
    security: {
      summary: "verify the image and the release security evidence",
      plan: () => [bun("release security", "scripts/verify-release-security.ts")],
    },
  },
  eval: {
    run: { summary: "offline evals", plan: () => [bun("eval", "apps/engine/eval/runner.ts")] },
    baseline: {
      summary: "offline evals, writing the baseline",
      plan: () => [bun("eval baseline", "apps/engine/eval/runner.ts", "--write-baseline")],
    },
    judge: {
      summary: "judge calibration",
      plan: () => [bun("eval judge", "apps/engine/eval/judge-calibration.ts")],
    },
    live: {
      summary: "live authoring eval (paid)",
      plan: () => [bun("eval live", "apps/engine/eval/live-authoring.ts")],
    },
    sweep: {
      summary: "live authoring sweep (paid)",
      plan: () => [bun("eval sweep", "apps/engine/eval/live-sweep.ts")],
    },
  },
  db: {
    generate: {
      summary: "generate a migration, normalize it, prune snapshots and embed",
      plan: () => [bun("db generate", "scripts/db-generate.ts")],
    },
    "admin-key": {
      summary: "issue an admin key",
      plan: () => [bun("admin key", "apps/engine/src/db/issue-admin-key.ts")],
    },
  },
  compose: {
    up: {
      summary: "start the stack",
      plan: () => [
        step("ensure env", ["sh", "scripts/ensure-env.sh"]),
        step("compose up", ["docker", "compose", "up", "-d"]),
      ],
    },
    down: {
      summary: "stop the stack",
      plan: () => [step("compose down", ["docker", "compose", "down"])],
    },
    logs: {
      summary: "follow the logs",
      plan: () => [step("compose logs", ["docker", "compose", "logs", "-f"])],
    },
    reset: {
      summary: "remove volumes and start again",
      plan: () => [
        step("compose down", ["docker", "compose", "down", "-v"]),
        step("ensure env", ["sh", "scripts/ensure-env.sh"]),
        step("compose up", ["docker", "compose", "up", "-d"]),
      ],
    },
    start: {
      summary: "start the stack, set up a first tenant and run the demo workflow",
      plan: () => [bun("compose start", "scripts/start-local.ts")],
    },
    "test-up": {
      summary: "start the test stack",
      plan: () => [
        step("compose test up", [
          "docker",
          "compose",
          "-f",
          "docker/docker-compose.test.yml",
          "up",
          "-d",
          "--build",
          "--wait",
        ]),
      ],
    },
    "test-down": {
      summary: "remove the test stack",
      plan: () => [
        step("compose test down", [
          "docker",
          "compose",
          "-f",
          "docker/docker-compose.test.yml",
          "down",
          "-v",
        ]),
      ],
    },
  },
};

const DEFAULTS: Readonly<Record<string, string>> = { verify: "full", eval: "run", demo: "start" };

function verifyPlan(ctx: Context, args: Args, mutation: MutationEvidence): Plan {
  const name = args.sub ?? DEFAULTS.verify ?? "";
  if (mutation === "deferred") {
    if (!gateFor(name as Profile).some((check) => check.id === "mutation-evidence"))
      return { ok: false, usage: `${DEFER_MUTATION_FLAG} applies only to: bun run verify release` };
    return {
      ok: true,
      steps: [
        bun("mutation deferred", "scripts/warn-mutation-deferred.ts"),
        ...gateFor(name as Profile)
          .filter((check) => check.id !== "mutation-evidence")
          .flatMap((check) => check.steps(ctx)),
      ],
    };
  }
  if ((PROFILES as readonly string[]).includes(name))
    return { ok: true, steps: gateFor(name as Profile).flatMap((check) => check.steps(ctx)) };
  const check = [...GATE, ...MANUAL_CHECKS].find((c) => c.id === name);
  if (check) return { ok: true, steps: check.steps(ctx) };
  return { ok: false, usage: usage("verify") };
}

function withRest(steps: readonly Step[], rest: readonly string[]): readonly Step[] {
  if (rest.length === 0 || steps.length === 0) return steps;
  const last = steps[steps.length - 1] as Step;
  return [...steps.slice(0, -1), { ...last, argv: [...last.argv, ...rest] }];
}

export function plan(concern: string, argv: readonly string[], ctx: Context): Plan {
  const args = parseArgs(argv);
  if (concern === "verify") {
    const { mutation, rest } = parseMutationDeferral(args.rest);
    const result = verifyPlan(ctx, args, mutation);
    return result.ok ? { ok: true, steps: withRest(result.steps, rest) } : result;
  }
  const subs = CONCERNS[concern];
  if (!subs)
    return {
      ok: false,
      usage: `unknown command ${concern}; known: ${[...Object.keys(CONCERNS), "verify"].join(", ")}`,
    };
  const sub = subs[args.sub ?? DEFAULTS[concern] ?? ""];
  if (!sub) return { ok: false, usage: usage(concern) };
  const first = args.rest[0] ?? "";
  const word = sub.word && !first.startsWith("-") ? first : "";
  const steps = sub.plan(ctx, args, word);
  if (steps.length === 0) return { ok: false, usage: usage(concern) };
  return { ok: true, steps: withRest(steps, word ? args.rest.slice(1) : args.rest) };
}

export function usage(concern: string): string {
  if (concern === "verify") {
    const profiles = PROFILES.map(
      (p) =>
        `  ${p.padEnd(18)} ${gateFor(p)
          .map((c) => c.id)
          .join(", ")}`,
    );
    const checks = [...GATE, ...MANUAL_CHECKS].map((c) => `  ${c.id.padEnd(18)} ${c.summary}`);
    return [
      "usage: bun run verify [profile|check]   (full by default)",
      "profiles:",
      ...profiles,
      "checks:",
      ...checks,
    ].join("\n");
  }
  const subs = CONCERNS[concern] ?? {};
  return [
    `usage: bun run ${concern} <${Object.keys(subs).join("|")}>`,
    ...Object.entries(subs).map(([name, sub]) => `  ${name.padEnd(18)} ${sub.summary}`),
  ].join("\n");
}
