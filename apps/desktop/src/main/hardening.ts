import {
  app,
  type Session,
  shell,
  systemPreferences,
  type WebContents,
  type WebPreferences,
} from "electron";
import { parseAppUrl } from "../shared/app-url.ts";
import {
  type PermissionAsk,
  permissionGranted,
  wantsMicrophone,
} from "../shared/permission-policy.ts";
import { isExternallyOpenable, type NavigationDecision } from "../shared/server-address.ts";
import { appLog } from "./app-log.ts";

const DEBUG_SWITCHES = [
  "inspect",
  "inspect-brk",
  "inspect-port",
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "js-flags",
  "disable-web-security",
  "allow-running-insecure-content",
  "ignore-certificate-errors",
];

export function hasDebugSwitch(argv: readonly string[]): boolean {
  return argv.some((value) =>
    DEBUG_SWITCHES.some((name) => value === `--${name}` || value.startsWith(`--${name}=`)),
  );
}

function originOf(raw: string | undefined): string | null {
  try {
    return raw ? new URL(raw).origin : null;
  } catch {
    return null;
  }
}

async function systemMicrophoneAllowed(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
  return systemPreferences.askForMediaAccess("microphone").catch(() => false);
}

export function hardenSession(session: Session, serverOrigin: string | null): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const ask: PermissionAsk = {
      permission,
      requester: originOf(details.requestingUrl),
      serverOrigin,
      mediaTypes: "mediaTypes" in details ? (details.mediaTypes ?? []) : [],
    };
    const granted = details.isMainFrame && permissionGranted(ask);
    if (!granted || !wantsMicrophone(ask)) {
      if (permission === "media")
        appLog.info("permission.media.denied", { media_types: ask.mediaTypes.join(",") });
      callback(granted);
      return;
    }
    void systemMicrophoneAllowed().then((allowed) => {
      appLog.info(allowed ? "permission.media.granted" : "permission.media.denied", {
        media_types: "audio",
        system: allowed,
      });
      callback(allowed);
    });
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    permissionGranted({
      permission,
      requester: originOf(requestingOrigin),
      serverOrigin,
      mediaTypes: details.mediaType ? [details.mediaType] : [],
    }),
  );
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

export function confineToAppScheme(session: Session): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const local = parseAppUrl(details.url) !== null || details.url.startsWith("devtools://");
    callback({ cancel: !local });
  });
}

export function securePreferences(preload: string, partition: string): WebPreferences {
  return {
    preload,
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    devTools: !app.isPackaged,
    spellcheck: true,
  };
}

export function openExternal(url: string): void {
  if (isExternallyOpenable(url)) void shell.openExternal(url).catch(() => {});
}

const guarded = new WeakSet<WebContents>();

export function guardWebContents(
  contents: WebContents,
  decide: (url: string) => NavigationDecision,
): void {
  guarded.add(contents);
  const route = (event: { preventDefault(): void }, url: string) => {
    const decision = decide(url);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openExternal(url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decide(url);
    if (decision === "allow") void contents.loadURL(url).catch(() => {});
    else if (decision === "external") openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => route(event, url));
  contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) route(event, url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

export function installGlobalGuards(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    setImmediate(() => {
      if (contents.isDestroyed() || guarded.has(contents)) return;
      guardWebContents(contents, () => "deny");
    });
  });
}
