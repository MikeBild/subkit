import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { INFO_PLIST_LOCALES, infoPlistStrings } from "../src/shared/app-identity.ts";
import { CHANNELS } from "../src/shared/channel.ts";
import { buildSigned, buildUpdates, updateFeedProblem } from "../src/shared/updates.ts";
import { FONT_FILES, FONT_PACKAGE } from "./fonts.ts";
import { generateIcons, RENDERED } from "./icons.ts";
import { uiResolve } from "./ui-resolve.ts";

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
    plugins: [uiResolve()],
    minify: target === "browser" && channel === "production",
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

async function buildStyles(input: string, output: string): Promise<void> {
  const run = Bun.spawnSync(
    [
      process.execPath,
      join(root, "node_modules/@tailwindcss/cli/dist/index.mjs"),
      "--input",
      input,
      "--output",
      output,
      ...(channel === "production" ? ["--minify"] : []),
    ],
    { cwd: root, stdout: "ignore", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(`Tailwind failed: ${run.stderr.toString()}`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "connect"), { recursive: true });
await bundle("src/main/index.ts", "main.cjs", "node", "cjs");
await bundle("src/runner/index.ts", "runner.cjs", "node", "cjs");
await bundle("src/preload/connect.ts", "preload-connect.cjs", "node", "cjs");
await bundle("src/preload/cockpit.ts", "preload-cockpit.cjs", "node", "cjs");
await bundle("src/connect/main.tsx", "connect/connect.js", "browser", "iife");
await cp(join(root, "src/connect/index.html"), join(dist, "connect/index.html"));
await buildStyles(join(root, "src/connect/styles.css"), join(dist, "connect/connect.css"));
await cp(join(root, "assets/icon.png"), join(dist, "connect/icon.png"));
await mkdir(join(dist, "connect/fonts"), { recursive: true });
for (const file of FONT_FILES) {
  await cp(join(root, FONT_PACKAGE, "files", file), join(dist, "connect/fonts", file));
}
await bundle("src/preload/shell.ts", "preload-shell.cjs", "node", "cjs");
await mkdir(join(dist, "shell/fonts"), { recursive: true });
await bundle("src/shell/main.tsx", "shell/shell.js", "browser", "iife");
await cp(join(root, "src/shell/shell.html"), join(dist, "shell/shell.html"));
for (const file of FONT_FILES) {
  await cp(join(root, FONT_PACKAGE, "files", file), join(dist, "shell/fonts", file));
}
await bundle("src/preload/live.ts", "preload-live.cjs", "node", "cjs");
await mkdir(join(dist, "live/fonts"), { recursive: true });
await bundle("src/live/main.tsx", "live/live.js", "browser", "iife");
await cp(join(root, "src/live/live.html"), join(dist, "live/live.html"));
for (const file of FONT_FILES) {
  await cp(join(root, FONT_PACKAGE, "files", file), join(dist, "live/fonts", file));
}
await buildStyles(join(root, "src/live/live.css"), join(dist, "live/live.css"));
const css = Bun.spawnSync(
  [
    join(root, "node_modules/.bin/tailwindcss"),
    "-i",
    join(root, "src/shell/shell.css"),
    "-o",
    join(dist, "shell/shell.css"),
    "--minify",
  ],
  { cwd: root, stdout: "inherit", stderr: "pipe" },
);
if (css.exitCode !== 0) throw new Error(`Tailwind failed: ${css.stderr.toString()}`);
if (process.argv.includes("--icons")) await generateIcons(root);
for (const [file] of RENDERED) {
  if (!(await Bun.file(join(root, "assets", file)).exists()))
    throw new Error(`assets/${file} is missing; render it with bun run build --icons on a Mac`);
}
await mkdir(join(dist, "assets"), { recursive: true });
for (const file of ["icon.png", "icon-mac.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
  await cp(join(root, "assets", file), join(dist, "assets", file));
}
for (const locale of INFO_PLIST_LOCALES) {
  await mkdir(join(dist, "mac", `${locale}.lproj`), { recursive: true });
  await writeFile(
    join(dist, "mac", `${locale}.lproj`, "InfoPlist.strings"),
    infoPlistStrings(locale, CHANNELS[channel].name),
  );
}
console.log(`Built SubKit Desktop into ${dist} (${channel}, updates ${updates ? "on" : "off"})`);
