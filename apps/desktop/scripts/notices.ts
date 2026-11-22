import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { renderRuntimeNotices } from "../../../scripts/lib/runtime-notices.ts";
import {
  collectNotices,
  noticeInputs,
  renderNoticeDraft,
  supplementNotices,
} from "../../../scripts/third-party-notices.ts";
import { agentDesktopNotice } from "../src/shared/local/agent-desktop-bundle.ts";
import {
  agentBrowserNotice,
  BrowserPinSchema,
  licenseMismatches,
} from "../src/shared/local/browser-runtime.ts";
import {
  missingPostgresNotices,
  postgresNoticePaths,
  renderEngineNotices,
  renderPostgresNotices,
} from "../src/shared/local/local-notices.ts";
import {
  ffmpegLicenseProblem,
  productLicense,
  renderFfmpegNotice,
} from "../src/shared/runtime-licenses.ts";
import agentBrowser from "../vendor/agent-browser.json";
import agentDesktop from "../vendor/agent-desktop.json";
import postgresManifest from "../vendor/postgres.json";
import { FONT_FILES, FONT_PACKAGE } from "./fonts.ts";
import { uiResolve } from "./ui-resolve.ts";

const CREDITS_FILE = "LICENSES.chromium.html";
const check = process.argv.includes("--check");

const app = resolve(import.meta.dir, "..");
const repo = resolve(app, "../..");
const work = join(app, "dist", "notices");
const graph = join(work, "main.json");

await mkdir(work, { recursive: true });
const nodeInputs: Record<string, object> = {};
for (const entry of ["src/main/index.ts", "src/runner/index.ts"]) {
  const bundle = await Bun.build({
    entrypoints: [join(app, entry)],
    target: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [uiResolve()],
    define: {
      SUBKIT_DESKTOP_UPDATES: "true",
      SUBKIT_DESKTOP_CHANNEL: JSON.stringify("production"),
    },
    metafile: true,
  });
  if (!bundle.success || !bundle.metafile)
    throw new Error(`Could not build the bundle graph of ${entry} for the notices`);
  for (const input of Object.keys(bundle.metafile.inputs)) nodeInputs[resolve(app, input)] = {};
}
await Bun.write(graph, JSON.stringify({ inputs: nodeInputs }));

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

const agentDesktopLicense = await readFile(join(app, "vendor", agentDesktop.license_file), "utf8");
if (createHash("sha256").update(agentDesktopLicense).digest("hex") !== agentDesktop.license_sha256)
  throw new Error("vendor/agent-desktop.LICENSE does not match its pinned SHA-256");
const helperNotice = agentDesktopNotice(
  agentDesktop.version,
  agentDesktop.source,
  agentDesktopLicense,
);

const browserPin = BrowserPinSchema.parse(agentBrowser);
const browserTexts = Object.fromEntries(
  await Promise.all(
    browserPin.licenses.map(
      async (entry) =>
        [entry.file, await readFile(join(app, "vendor", entry.file), "utf8")] as const,
    ),
  ),
);
const browserMismatches = licenseMismatches(browserPin, browserTexts);
if (browserMismatches.length)
  throw new Error(
    `These agent-browser license texts do not match their pinned SHA-256: ${browserMismatches.map((file) => `vendor/${file}`).join(", ")}`,
  );
const browserNotice = agentBrowserNotice(browserPin, browserTexts);

const distribution = join(app, "node_modules/electron/dist");
const credits = Bun.file(join(distribution, CREDITS_FILE));
if (!(await credits.exists())) {
  if (!check)
    throw new Error(
      `The Electron distribution is not installed, so ${CREDITS_FILE} is missing: run "node node_modules/electron/install.js" in apps/desktop first`,
    );
  console.log(
    `${packages.length} packages, the Electron runtime notices and the pinned agent-desktop and agent-browser licenses are complete; ${CREDITS_FILE} was not checked because the Electron distribution is not installed`,
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
async function localNotices(): Promise<string> {
  if (process.platform !== "darwin") return "";
  const engine = Bun.file(
    join(repo, "dist", "engine-desktop", "mac", "THIRD_PARTY_NOTICES.engine.txt"),
  );
  if (!(await engine.exists()))
    throw new Error(
      `The engine notices are missing: run "bun run build desktop-engine" in the repository first`,
    );
  let text = renderEngineNotices(await engine.text());
  const folder = join(app, "resources", "postgres", `darwin-${process.arch}`);
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => {
    throw new Error(
      `PostgreSQL is not fetched: run "bun scripts/fetch-postgres.ts" in apps/desktop first`,
    );
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"));
  const missing = missingPostgresNotices(files);
  if (missing.length)
    throw new Error(`The PostgreSQL bundle lacks the notices for: ${missing.join(", ")}`);
  const texts = await Promise.all(
    postgresNoticePaths(files).map(async (path) => ({
      path,
      text: await readFile(join(folder, path), "utf8"),
    })),
  );
  text += renderPostgresNotices(postgresManifest.version, texts);
  return text;
}

if (check) {
  console.log(
    `${packages.length} packages, the Electron runtime notices, the pinned agent-desktop and agent-browser licenses and the FFmpeg entry of ${CREDITS_FILE} are complete`,
  );
  process.exit(0);
}

const target = join(app, "dist", "THIRD_PARTY_NOTICES.txt");
await Bun.write(
  target,
  renderNoticeDraft(packages) +
    runtime +
    ffmpeg +
    helperNotice +
    browserNotice +
    (await localNotices()),
);
await copyFile(join(distribution, CREDITS_FILE), join(app, "dist", CREDITS_FILE));
await copyFile(join(distribution, "LICENSE"), join(app, "dist", "LICENSE.electron.txt"));
console.log(
  `${packages.length} packages, the Electron runtime notices and the FFmpeg entry written to ${target}`,
);
