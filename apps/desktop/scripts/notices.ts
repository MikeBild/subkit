import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { renderRuntimeNotices } from "../../../scripts/runtime-notices.ts";
import {
  collectNotices,
  noticeInputs,
  renderNoticeDraft,
  supplementNotices,
} from "../../../scripts/third-party-notices.ts";
import {
  ffmpegLicenseProblem,
  productLicense,
  renderFfmpegNotice,
} from "../src/shared/runtime-licenses.ts";
import { FONT_FILES, FONT_PACKAGE } from "./fonts.ts";
import { uiResolve } from "./ui-resolve.ts";

const CREDITS_FILE = "LICENSES.chromium.html";
const check = process.argv.includes("--check");

const app = resolve(import.meta.dir, "..");
const repo = resolve(app, "../..");
const work = join(app, "dist", "notices");
const graph = join(work, "main.json");

await mkdir(work, { recursive: true });
const build = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "apps/desktop/src/main/index.ts",
    "--target=node",
    "--format=cjs",
    "--external",
    "electron",
    "--define",
    "SUBKIT_DESKTOP_UPDATES=true",
    "--define",
    'SUBKIT_DESKTOP_CHANNEL="production"',
    `--metafile=${graph}`,
    "--outfile",
    join(work, "main.cjs"),
  ],
  { cwd: repo, stdout: "ignore", stderr: "inherit" },
);
if (build.exitCode !== 0) throw new Error("Could not build the bundle graph for the notices");

const shellGraph = join(work, "shell.json");
const shell = await Bun.build({
  entrypoints: [join(app, "src/shell/main.tsx")],
  target: "browser",
  format: "iife",
  plugins: [uiResolve()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  metafile: true,
});
if (!shell.success || !shell.metafile)
  throw new Error("Could not build the shell bundle graph for the notices");
const shellInputs = Object.fromEntries(
  Object.keys(shell.metafile.inputs).map((input) => [resolve(app, input), {}]),
);
await Bun.write(shellGraph, JSON.stringify({ inputs: shellInputs }));
const connect = await Bun.build({
  entrypoints: [join(app, "src/connect/main.tsx")],
  target: "browser",
  plugins: [uiResolve()],
  metafile: true,
});
if (!connect.success || !connect.metafile)
  throw new Error("Could not build the bundle graph of the sign-in window for the notices");
const connectInputs = Object.keys(connect.metafile.inputs).map((input) =>
  relative(repo, resolve(process.cwd(), input)),
);

const packages = await supplementNotices(
  await collectNotices(repo, [
    ...(await noticeInputs(graph)),
    ...(await noticeInputs(shellGraph)),
    ...connectInputs,
    ...FONT_FILES.map((file) => join("apps/desktop", FONT_PACKAGE, "files", file)),
    "apps/desktop/node_modules/tailwindcss/preflight.css",
  ]),
  join(repo, "vendor/notices/manifest.json"),
);
if (!packages.length) throw new Error("No third-party packages found");
const missing = packages.filter((item) => !item.texts.length);
if (missing.length) {
  throw new Error(
    `Add a notice to vendor/notices/manifest.json for: ${missing
      .map((item) => `${item.name}@${item.version}`)
      .join(", ")}`,
  );
}

const manifest = join(repo, "vendor/desktop-runtime-notices/manifest.json");
const pinned = JSON.parse(await readFile(manifest, "utf8")) as {
  runtime: { revision: string };
  ffmpeg?: { revision?: string; statement?: string };
};
const electron = JSON.parse(
  await readFile(join(app, "node_modules/electron/package.json"), "utf8"),
) as { version: string };
const runtime = await renderRuntimeNotices(
  manifest,
  electron.version,
  pinned.runtime.revision,
  "Electron",
);
const statement = pinned.ffmpeg?.statement ?? "";
if (!pinned.ffmpeg?.revision || !statement.includes(pinned.ffmpeg.revision))
  throw new Error("The runtime notice manifest names no FFmpeg source revision");
if (!/Written offer:/.test(statement))
  throw new Error("The runtime notice manifest carries no written offer for FFmpeg");

const distribution = join(app, "node_modules/electron/dist");
const credits = Bun.file(join(distribution, CREDITS_FILE));
if (!(await credits.exists())) {
  if (!check)
    throw new Error(
      `The Electron distribution is not installed, so ${CREDITS_FILE} is missing: run "node node_modules/electron/install.js" in apps/desktop first`,
    );
  console.log(
    `${packages.length} packages and the Electron runtime notices are complete; ${CREDITS_FILE} was not checked because the Electron distribution is not installed`,
  );
  process.exit(0);
}

const bytes = Buffer.from(await credits.arrayBuffer());
const license = productLicense(bytes.toString("utf8"), "ffmpeg");
if (!license) throw new Error(`${CREDITS_FILE} has no FFmpeg entry`);
const problem = ffmpegLicenseProblem(license);
if (problem) throw new Error(`${CREDITS_FILE}: ${problem}`);
const ffmpeg = renderFfmpegNotice({
  runtimeVersion: electron.version,
  creditsFile: CREDITS_FILE,
  creditsBytes: bytes.length,
  creditsSha256: createHash("sha256").update(bytes).digest("hex"),
  license,
  sourceStatement: statement,
});
if (check) {
  console.log(
    `${packages.length} packages, the Electron runtime notices and the FFmpeg entry of ${CREDITS_FILE} are complete`,
  );
  process.exit(0);
}

const target = join(app, "dist", "THIRD_PARTY_NOTICES.txt");
await Bun.write(target, renderNoticeDraft(packages) + runtime + ffmpeg);
await copyFile(join(distribution, CREDITS_FILE), join(app, "dist", CREDITS_FILE));
await copyFile(join(distribution, "LICENSE"), join(app, "dist", "LICENSE.electron.txt"));
console.log(
  `${packages.length} packages, the Electron runtime notices and the FFmpeg entry written to ${target}`,
);
