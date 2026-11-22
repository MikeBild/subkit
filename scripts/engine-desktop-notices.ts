import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { engineMetafile } from "./build-engine-desktop.ts";
import { parseEngineDesktopArgs } from "./lib/engine-desktop-targets.ts";
import { renderRuntimeNotices } from "./lib/runtime-notices.ts";
import {
  collectNotices,
  noticeInputs,
  renderModelNotices,
  renderNoticeDraft,
  supplementNotices,
} from "./third-party-notices.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const OUT = join(REPO_ROOT, "dist", "engine-desktop");
const COCKPIT_MAPS = join(REPO_ROOT, "dist", "notice-cockpit", "assets");
export const ENGINE_NOTICES_FILE = "THIRD_PARTY_NOTICES.engine.txt";

async function buildCockpitMaps(): Promise<void> {
  await rm(join(REPO_ROOT, "dist", "notice-cockpit"), { recursive: true, force: true });
  const proc = Bun.spawn(
    [
      "bunx",
      "vite",
      "build",
      "--config",
      "apps/cockpit/vite.config.ts",
      "--sourcemap",
      "--outDir",
      join(REPO_ROOT, "dist", "notice-cockpit"),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  if ((await proc.exited) !== 0) throw new Error("the cockpit build for the notices failed");
}

async function noticesFor(graphs: string[]): Promise<string> {
  const inputs: string[] = [];
  for (const graph of graphs) inputs.push(...(await noticeInputs(graph)));
  const packages = await supplementNotices(
    await collectNotices(REPO_ROOT, inputs),
    join(REPO_ROOT, "vendor/notices/manifest.json"),
  );
  if (!packages.length) throw new Error("No third-party packages found in the engine");
  const missing = packages.filter((item) => !item.texts.length);
  if (missing.length)
    throw new Error(
      `Add a notice to vendor/notices/manifest.json for: ${missing.map((item) => `${item.name}@${item.version}`).join(", ")}`,
    );
  const runtime = await renderRuntimeNotices(
    join(REPO_ROOT, "vendor/runtime-notices/manifest.json"),
    Bun.version,
    Bun.revision,
  );
  const models = await renderModelNotices(
    join(REPO_ROOT, "vendor/notices/models.json"),
    join(REPO_ROOT, "vendor/embedding-assets.json"),
  );
  return renderNoticeDraft(packages) + runtime + models;
}

async function main(): Promise<void> {
  const parsed = parseEngineDesktopArgs(Bun.argv.slice(2));
  if (!parsed.ok) throw new Error(parsed.error);
  const out = parsed.args.out ?? OUT;
  await buildCockpitMaps();
  const maps = (await readdir(COCKPIT_MAPS))
    .filter((name) => name.endsWith(".map"))
    .map((name) => join(COCKPIT_MAPS, name));
  if (!maps.length) throw new Error(`no cockpit source maps in ${COCKPIT_MAPS}`);
  for (const target of parsed.args.targets) {
    const file = join(out, target.os, ENGINE_NOTICES_FILE);
    await mkdir(join(out, target.os), { recursive: true });
    await Bun.write(file, await noticesFor([engineMetafile(out, target), ...maps]));
    console.log(`engine notices for ${target.name} written to ${file}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
