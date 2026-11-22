import "./early-guard.ts";
import { join } from "node:path";
import { app } from "electron";
import { protocolRegistration } from "../shared/channel.ts";
import { findDeepLink, secondInstanceAction } from "../shared/deep-link.ts";
import { appLog } from "./app-log.ts";
import { registerAppScheme } from "./app-protocol.ts";
import { CHANNEL } from "./channel.ts";
import { crashCapture } from "./crash-capture.ts";
import { diagnosticsText } from "./diagnostics.ts";
import { releaseEarlyGuard } from "./early-guard.ts";
import { hasDebugSwitch, installGlobalGuards } from "./hardening.ts";
import { launchedHidden } from "./login-item.ts";
import { Shell } from "./shell.ts";
import { showStartupFailure } from "./startup-failure.ts";

function registerProtocol(): void {
  const { scheme, executable, args } = protocolRegistration({
    scheme: CHANNEL.scheme,
    defaultApp: Boolean(process.defaultApp),
    execPath: process.execPath,
    argv: process.argv,
  });
  if (executable) app.setAsDefaultProtocolClient(scheme, executable, args);
  else app.setAsDefaultProtocolClient(scheme);
}

function openLog(): void {
  try {
    const folder = app.getPath("logs");
    appLog.open(folder);
    crashCapture.start(folder);
  } catch {}
  appLog.info("app.launch", {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    channel: CHANNEL.channel,
  });
}

function fallbackDiagnostics(): string {
  return diagnosticsText({
    locale: "en",
    serverOrigin: null,
    serverVersion: null,
    connection: "unknown",
    profileCount: 0,
    errors: [],
  });
}

function main(): void {
  let shell: Shell | null = null;
  process.on("uncaughtException", (error) => {
    appLog.error("main.uncaught", error);
    shell?.errors.record("main.uncaught", error);
  });
  process.on("unhandledRejection", (reason) => {
    appLog.error("main.unhandled", reason);
    shell?.errors.record("main.unhandled", reason);
  });
  if (app.isPackaged && hasDebugSwitch(process.argv)) {
    app.exit(1);
    return;
  }
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }

  registerAppScheme();
  app.enableSandbox();
  app.setName(CHANNEL.name);
  openLog();
  releaseEarlyGuard();
  appLog.info("app.single_instance.acquired");
  app.setAppUserModelId(CHANNEL.appId);
  installGlobalGuards();

  let pendingLink = findDeepLink(process.argv, CHANNEL.scheme);

  const deliver = (link: string) => {
    if (shell) shell.handleDeepLink(link);
    else pendingLink = link;
  };

  const droppedOnDock: string[] = [];
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (shell) shell.dropFiles([path], "dock");
    else droppedOnDock.push(path);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliver(url);
  });
  app.on("second-instance", (_event, argv) => {
    const action = secondInstanceAction(argv, CHANNEL.scheme);
    if (action.kind === "link") deliver(action.link);
    else if (action.kind === "open") shell?.open();
  });
  app.on("activate", () => shell?.open());
  app.on("window-all-closed", () => {});
  let localStopped = false;
  app.on("before-quit", (event) => {
    appLog.info("app.quit");
    shell?.beforeQuit();
    if (localStopped || !shell?.localWorkspace.running) return;
    event.preventDefault();
    void shell.localWorkspace.stop().finally(() => {
      localStopped = true;
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    appLog.info("app.ready");
    try {
      registerProtocol();
      if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), "dist/assets/icon-mac.png"));
      shell = new Shell();
      shell.start(pendingLink, launchedHidden());
      pendingLink = null;
      if (droppedOnDock.length) shell.dropFiles(droppedOnDock.splice(0), "dock");
      appLog.info("app.started");
    } catch (error) {
      const current = shell;
      await showStartupFailure("app", error, {
        locale: current ? () => current.locale() : undefined,
        diagnostics: fallbackDiagnostics,
      });
      app.exit(1);
    }
  });
}

main();
