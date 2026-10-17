import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  collectNotices,
  noticeInputs,
  renderNoticeDraft,
  supplementNotices,
} from "./third-party-notices.ts";

const root = resolve(import.meta.dir, "..");
const directory = join(root, ".artifacts/third-party-notices");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
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
const draft = renderNoticeDraft(packages);
const missing = packages
  .filter((item) => !item.texts.length)
  .map((item) => `${item.name}@${item.version}`);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
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
      lockSha256: hash(await readFile(join(root, "bun.lock"))),
      manifestSha256: hash(await readFile(join(root, "vendor/notices/manifest.json"))),
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
