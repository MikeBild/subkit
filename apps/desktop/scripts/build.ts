import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildSigned, buildUpdates, updateFeedProblem } from "../src/shared/updates.ts";
import { FONT_FILES, FONT_PACKAGE } from "./fonts.ts";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const channel = process.argv.includes("--production") ? "production" : "development";
const decision = buildUpdates({
  flag: process.env.SUBKIT_DESKTOP_UPDATES,
  production: channel === "production",
  signed: buildSigned(process.platform, process.env),
  feedProblem: updateFeedProblem(await Bun.file(join(root, "electron-builder.yml")).text()),
});
if (decision.error) throw new Error(decision.error);
const updates = decision.enabled;

async function bundle(
  entry: string,
  outfile: string,
  target: "node" | "browser",
  format: "cjs" | "iife",
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    target,
    format,
    external: ["electron"],
    minify: false,
    define: {
      SUBKIT_DESKTOP_UPDATES: JSON.stringify(updates),
      SUBKIT_DESKTOP_CHANNEL: JSON.stringify(channel),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Build failed for ${entry}`);
  }
  const [artifact] = result.outputs;
  if (!artifact || result.outputs.length !== 1) throw new Error(`Unexpected outputs for ${entry}`);
  await Bun.write(join(dist, outfile), await artifact.text());
}

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "connect"), { recursive: true });
await bundle("src/main/index.ts", "main.cjs", "node", "cjs");
await bundle("src/preload/connect.ts", "preload-connect.cjs", "node", "cjs");
await bundle("src/preload/cockpit.ts", "preload-cockpit.cjs", "node", "cjs");
await bundle("src/connect/connect.ts", "connect/connect.js", "browser", "iife");
await cp(join(root, "src/connect/index.html"), join(dist, "connect/index.html"));
await cp(join(root, "src/connect/connect.css"), join(dist, "connect/connect.css"));
await cp(join(root, "assets/icon.png"), join(dist, "connect/icon.png"));
await mkdir(join(dist, "connect/fonts"), { recursive: true });
for (const file of FONT_FILES) {
  await cp(join(root, FONT_PACKAGE, "files", file), join(dist, "connect/fonts", file));
}
await mkdir(join(dist, "assets"), { recursive: true });
for (const file of ["icon.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
  await cp(join(root, "assets", file), join(dist, "assets", file));
}
console.log(`Built SubKit Desktop into ${dist} (${channel}, updates ${updates ? "on" : "off"})`);
