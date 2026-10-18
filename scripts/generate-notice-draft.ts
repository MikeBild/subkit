import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { renderRuntimeNotices } from "./runtime-notices.ts";
import {
  collectNotices,
  noticeInputs,
  renderNoticeDraft,
  supplementNotices,
} from "./third-party-notices.ts";

const root = resolve(import.meta.dir, "..");
const directory = join(root, ".artifacts/third-party-notices");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Could not bind notice draft to Git state");
  return result.stdout.toString().trim();
}
const sourceCommit = git(["rev-parse", "HEAD"]);
const sourceStatus = git(["status", "--porcelain"]);
await mkdir(directory, { recursive: true });

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`Notice build failed: ${args[0]}`);
}

const graphs: string[] = [];
for (const target of ["engine", "sk"]) {
  const graph = join(directory, `${target}.json`);
  await run([
    "build",
    `apps/${target}/src/index.ts`,
    "--compile",
    "--external",
    "cpu-features",
    "--define",
    "process.env.NODE_ENV=process.env.NODE_ENV",
    "--define",
    `BUILD_VERSION=${JSON.stringify(packageJson.version)}`,
    `--metafile=${graph}`,
    "--outfile",
    join(directory, target),
  ]);
  graphs.push(graph);
}
const browserDirectory = join(directory, "cockpit");
await run([
  "x",
  "vite",
  "build",
  "--config",
  "apps/cockpit/vite.config.ts",
  "--sourcemap",
  "--outDir",
  browserDirectory,
]);
const maps = [...new Bun.Glob("**/*.map").scanSync({ cwd: browserDirectory })].sort();
if (!maps.length) throw new Error("Browser notice source maps are missing");
graphs.push(...maps.map((file) => join(browserDirectory, file)));
const inputs = (await Promise.all(graphs.map(noticeInputs))).flat();
const packages = await supplementNotices(
  await collectNotices(root, inputs),
  join(root, "vendor/notices/manifest.json"),
);
if (!packages.length) throw new Error("Notice inventory is empty");
const runtimeManifest = join(root, "vendor/runtime-notices/manifest.json");
const runtime = await renderRuntimeNotices(runtimeManifest, Bun.version, Bun.revision);
const draft = renderNoticeDraft(packages) + runtime;
const missing = packages
  .filter((item) => !item.texts.length)
  .map((item) => `${item.name}@${item.version}`);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const evidenceFiles = [...graphs, join(directory, "engine"), join(directory, "sk")];
const evidence = await Promise.all(
  evidenceFiles.map(async (path) => ({
    path: relative(root, path),
    sha256: hash(await readFile(path)),
  })),
);
if (git(["rev-parse", "HEAD"]) !== sourceCommit || git(["status", "--porcelain"]) !== sourceStatus)
  throw new Error("Git state changed while generating notices");
await writeFile(join(directory, "THIRD_PARTY_NOTICES.txt"), draft);
await writeFile(
  join(directory, "report.json"),
  `${JSON.stringify(
    {
      status: "UNVERIFIED",
      scope:
        "Fresh native engine/CLI build graphs and browser source maps; full runtime/model/container coverage and legal approval remain separate",
      bun: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      sourceCommit,
      worktreeDirty: sourceStatus.length > 0,
      evidence,
      lockSha256: hash(await readFile(join(root, "bun.lock"))),
      manifestSha256: hash(await readFile(join(root, "vendor/notices/manifest.json"))),
      runtimeManifestSha256: hash(await readFile(runtimeManifest)),
      draftSha256: hash(draft),
      packages: packages.map((item) => ({
        name: item.name,
        version: item.version,
        notices: item.texts.map(({ name, sha256 }) => ({ name, sha256 })),
      })),
      missing,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Notice draft: ${packages.length} packages, ${missing.length} missing texts; ${directory}`,
);
