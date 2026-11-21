import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const [out, prefix = "shell"] = process.argv.slice(2);
if (!out) throw new Error("Usage: bun scripts/preview-shell.ts <out-dir> [prefix]");

const dir = join(root, "dist", "preview");
await mkdir(dir, { recursive: true });
for (const [entry, file] of [
  ["scripts/preview/main.ts", "main.cjs"],
  ["scripts/preview/preload.ts", "preload.cjs"],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  const [artifact] = result.outputs;
  if (!result.success || !artifact) throw new Error(`Preview build failed for ${entry}`);
  await Bun.write(join(dir, file), await artifact.text());
}

const electron = join(root, "node_modules/.bin/electron");
const run = Bun.spawnSync(
  [electron, join(dir, "main.cjs"), `--out=${resolve(out)}`, `--prefix=${prefix}`],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exit(run.exitCode ?? 1);
