import { app } from "electron";
import { protocolRegistration } from "../shared/channel.ts";
import { findDeepLink, secondInstanceAction } from "../shared/deep-link.ts";
import { registerAppScheme } from "./app-protocol.ts";
import { CHANNEL } from "./channel.ts";
import { hasDebugSwitch, installGlobalGuards } from "./hardening.ts";
import { launchedHidden } from "./login-item.ts";
import { Shell } from "./shell.ts";

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

function main(): void {
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
  app.setAppUserModelId(CHANNEL.appId);
  installGlobalGuards();

  let shell: Shell | null = null;
  let pendingLink = findDeepLink(process.argv, CHANNEL.scheme);

  const deliver = (link: string) => {
    if (shell) shell.handleDeepLink(link);
    else pendingLink = link;
  };

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
  app.on("before-quit", () => shell?.beforeQuit());

  process.on("uncaughtException", (error) => shell?.errors.record("main.uncaught", error));
  process.on("unhandledRejection", (reason) => shell?.errors.record("main.unhandled", reason));

  void app.whenReady().then(() => {
    registerProtocol();
    shell = new Shell();
    shell.start(pendingLink, launchedHidden());
    pendingLink = null;
  });
}

main();
