import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme, session } from "electron";
import { registerAppScheme, serveAppFiles } from "../../src/main/app-protocol.ts";
import { APP_SCHEME } from "../../src/shared/app-url.ts";
import type { Locale } from "../../src/shared/i18n.ts";
import { CAPTURE_WINDOW } from "../../src/shared/window-frame.ts";
import {
  CONNECT_SCENARIOS,
  connectState,
  type PreviewStep,
  SCENARIOS,
  scenarioState,
} from "./fixtures.ts";

const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? "";
const prefix = process.argv.find((arg) => arg.startsWith("--prefix="))?.slice(9) ?? "shell";
const dist = join(app.getAppPath(), "..");
const PARTITION = "preview";
const SAMPLE_NOTE = "Rechnung Q4 an die Buchhaltung weitergeben";
const SAMPLE_NOTE_EN = "Forward the Q4 invoice to accounting";

registerAppScheme();
app.enableSandbox();
app.on("window-all-closed", () => {});

let current: unknown = null;
let connect: unknown = null;
let check: unknown = null;
let invite: unknown = null;
ipcMain.handle("preview:state", () => current);
ipcMain.handle("preview:connect-state", () => connect);
ipcMain.handle("preview:connect-check", () => check);
ipcMain.handle("preview:connect-invite", () => invite);
ipcMain.handle("preview:show-view", (_event, view: unknown) => {
  if (connect && typeof connect === "object") connect = { ...connect, view };
  return connect;
});

function stepScript(step: PreviewStep): string {
  const target = `document.querySelector('[data-testid="${"click" in step ? step.click : step.into}"]')`;
  if ("click" in step) return `${target}.click();`;
  return `(() => { const input = ${target}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, ${JSON.stringify(step.type)}); input.dispatchEvent(new Event("input", { bubbles: true })); })();`;
}

async function shoot(): Promise<void> {
  if (!out) throw new Error("--out=<dir> is required");
  await mkdir(out, { recursive: true });
  serveAppFiles(session.fromPartition(PARTITION), join(dist, "shell"));
  const window = new BrowserWindow({
    width: 560,
    height: 600,
    show: false,
    frame: false,
    webPreferences: {
      partition: PARTITION,
      preload: join(dist, "preview", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  window.webContents.on("console-message", (event) => console.log("page:", event.message));
  let run = 0;
  for (const scenario of SCENARIOS) {
    for (const locale of ["de", "en"] as Locale[]) {
      for (const dark of [false, true]) {
        current = scenarioState(scenario, locale, dark);
        window.setBackgroundColor(dark ? "#1b2130" : "#d9dde5");
        const size = scenario.view === "capture" ? CAPTURE_WINDOW : { width: 1280, height: 800 };
        window.setContentSize(size.width, size.height);
        run += 1;
        await window.loadURL(`subkit-app://shell/shell.html?run=${run}#${scenario.view}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (scenario.name === "capture" || scenario.name === "capture-offline")
          window.webContents.insertText(locale === "de" ? SAMPLE_NOTE : SAMPLE_NOTE_EN);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const image = await window.webContents.capturePage();
        const name = `${prefix}-${scenario.name}-${locale}-${dark ? "dark" : "light"}.png`;
        await writeFile(join(out, name), image.toPNG());
        console.log(name);
      }
    }
  }
  window.destroy();
  await shootConnect();
}

async function shootConnect(): Promise<void> {
  const preview = session.fromPartition(PARTITION);
  preview.protocol.unhandle(APP_SCHEME);
  serveAppFiles(preview, join(dist, "connect"));
  const window = new BrowserWindow({
    width: 520,
    height: 720,
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: join(dist, "preview", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  window.webContents.on("console-message", (event) => console.log("page:", event.message));
  let run = 0;
  for (const scenario of CONNECT_SCENARIOS) {
    for (const locale of ["de", "en"] as Locale[]) {
      for (const dark of [false, true]) {
        connect = connectState(scenario, locale);
        check = scenario.check ?? null;
        invite = scenario.invite ?? null;
        nativeTheme.themeSource = dark ? "dark" : "light";
        window.setContentSize(520, 720);
        run += 1;
        await window.loadURL(`subkit-app://shell/index.html?run=${run}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        for (const step of scenario.steps ?? []) {
          await window.webContents.executeJavaScript(stepScript(step));
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        const image = await window.webContents.capturePage();
        const name = `${prefix}-connect-${scenario.name}-${locale}-${dark ? "dark" : "light"}.png`;
        await writeFile(join(out, name), image.toPNG());
        console.log(name);
      }
    }
  }
  window.destroy();
}

void app.whenReady().then(async () => {
  try {
    await shoot();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  app.quit();
});
