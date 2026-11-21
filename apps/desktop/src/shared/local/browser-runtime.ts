import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const PinnedAssetSchema = z.object({
  asset: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256,
});

const PinnedLicenseSchema = z.object({
  component: z.string().min(1),
  license: z.string().min(1),
  file: z.string().regex(/^agent-browser[a-z.-]*\.LICENSE$/),
  upstream: z.string().min(1),
  source: z.url(),
  sha256,
});
export type PinnedLicense = z.infer<typeof PinnedLicenseSchema>;

export const BrowserPinSchema = z.object({
  source: z.url(),
  license: z.literal("Apache-2.0"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  license_ref: z.string().regex(/^[a-f0-9]{40}$/),
  licenses: z.array(PinnedLicenseSchema).min(1),
  targets: z.record(z.string(), PinnedAssetSchema),
  chrome_for_testing: z.object({
    source: z.url(),
    license: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),
    targets: z.record(z.string(), PinnedAssetSchema.extend({ executable: z.string().min(1) })),
  }),
});
export type BrowserPin = z.infer<typeof BrowserPinSchema>;

export type BrowserTarget = "darwin-arm64";
export const BROWSER_TARGETS: readonly BrowserTarget[] = ["darwin-arm64"];

export function browserTargetFor(platform: string, arch: string): BrowserTarget | null {
  const target = `${platform}-${arch}`;
  return (BROWSER_TARGETS as readonly string[]).includes(target) ? (target as BrowserTarget) : null;
}

export interface BrowserCliLocation {
  readonly packaged: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly resourcesPath: string;
  readonly appRoot: string;
}

export function browserCliPath(location: BrowserCliLocation): string | null {
  const target = browserTargetFor(location.platform, location.arch);
  if (target === null) return null;
  return location.packaged
    ? join(location.resourcesPath, "agent-browser", "agent-browser")
    : join(location.appRoot, "resources", "agent-browser", target, "agent-browser");
}

export interface PinnedDownload {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export function agentBrowserDownload(pin: BrowserPin, target: BrowserTarget): PinnedDownload {
  const asset = pin.targets[target];
  if (!asset) throw new Error(`no pinned agent-browser for ${target}`);
  return {
    url: `${pin.source}/releases/download/v${pin.version}/${asset.asset}`,
    bytes: asset.bytes,
    sha256: asset.sha256,
  };
}

export function chromeDownload(pin: BrowserPin, target: BrowserTarget): PinnedDownload {
  const chrome = pin.chrome_for_testing;
  const asset = chrome.targets[target];
  if (!asset) throw new Error(`no pinned Chrome for Testing for ${target}`);
  return {
    url: `${chrome.source}/${chrome.version}/${asset.asset}`,
    bytes: asset.bytes,
    sha256: asset.sha256,
  };
}

export function licenseMismatches(
  pin: Pick<BrowserPin, "licenses">,
  texts: Readonly<Record<string, string>>,
): string[] {
  return pin.licenses
    .filter((entry) => {
      const text = texts[entry.file];
      return text === undefined || createHash("sha256").update(text).digest("hex") !== entry.sha256;
    })
    .map((entry) => entry.file);
}

const RULE = "================================================================================";
const LINE = "--------------------------------------------------------------------------------";

export function agentBrowserNotice(
  pin: Pick<BrowserPin, "version" | "source" | "license_ref" | "licenses">,
  texts: Readonly<Record<string, string>>,
): string {
  const lines = [
    "",
    RULE,
    `agent-browser ${pin.version} (Apache-2.0)`,
    pin.source,
    `License texts as of ${pin.source}/tree/${pin.license_ref}`,
    "The agent-browser binary ships unchanged; SubKit only re-signs it. Chrome for Testing is downloaded on first use and is not part of the app.",
  ];
  for (const entry of pin.licenses) {
    lines.push(
      LINE,
      `${entry.component} (${entry.license}), ${entry.upstream}`,
      `Source: ${entry.source}`,
      LINE,
      (texts[entry.file] ?? "").trimEnd(),
    );
  }
  lines.push("");
  return lines.join("\n");
}

export interface BrowserLayout {
  readonly root: string;
  readonly chrome_dir: string;
  readonly chrome_executable: string;
  readonly profiles: string;
  readonly sockets: string;
  readonly downloads: string;
  readonly captures: string;
  readonly config: string;
}

export const SOCKET_PATH_MAX = 103;
const SOCKET_FILE_LENGTH = "/subkit-0123456789.sock".length;

export function socketDir(root: string, tmpDir: string): string {
  const preferred = join(root, "r");
  return preferred.length + SOCKET_FILE_LENGTH <= SOCKET_PATH_MAX
    ? preferred
    : join(tmpDir, "subkit-browser");
}

export function browserLayout(
  dataDir: string,
  pin: BrowserPin,
  target: BrowserTarget,
  tmpDir: string,
) {
  const root = join(dataDir, "browser");
  const chrome = pin.chrome_for_testing;
  const asset = chrome.targets[target];
  if (!asset) throw new Error(`no pinned Chrome for Testing for ${target}`);
  const chromeDir = join(root, `chrome-${chrome.version}`);
  return {
    root,
    chrome_dir: chromeDir,
    chrome_executable: join(chromeDir, asset.executable),
    profiles: join(root, "profiles"),
    sockets: socketDir(root, tmpDir),
    downloads: join(root, "downloads"),
    captures: join(root, "captures"),
    config: join(root, "agent-browser.json"),
  } satisfies BrowserLayout;
}

export const DEFAULT_PARTITION = "default";

export function profileDir(layout: BrowserLayout, partition: string): string {
  return join(layout.profiles, partition);
}

export function sessionName(partition: string): string {
  return `subkit-${createHash("sha256").update(partition).digest("hex").slice(0, 10)}`;
}

export const CHROME_ARGS: readonly string[] = [
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--deny-permission-prompts",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-breakpad",
  "--disable-crash-reporter",
  "--disable-crashpad-for-testing",
  "--disable-features=WebAuthenticationConditionalUI,AutofillServerCommunication,MediaRouter",
];

export interface AgentBrowserEnvInput {
  readonly layout: BrowserLayout;
  readonly partition: string;
  readonly proxy: string;
  readonly path: string | undefined;
}

export function agentBrowserEnv(input: AgentBrowserEnvInput): Record<string, string> {
  const { layout } = input;
  return {
    PATH: input.path ?? "/usr/bin:/bin",
    HOME: layout.root,
    TMPDIR: join(layout.root, "tmp"),
    AGENT_BROWSER_CONFIG: layout.config,
    AGENT_BROWSER_SOCKET_DIR: layout.sockets,
    AGENT_BROWSER_SESSION: sessionName(input.partition),
    AGENT_BROWSER_PROFILE: profileDir(layout, input.partition),
    AGENT_BROWSER_EXECUTABLE_PATH: layout.chrome_executable,
    AGENT_BROWSER_DOWNLOAD_PATH: layout.downloads,
    AGENT_BROWSER_SCREENSHOT_DIR: layout.captures,
    AGENT_BROWSER_PROXY: input.proxy,
    AGENT_BROWSER_PROXY_BYPASS: "<-loopback>",
    AGENT_BROWSER_ARGS: CHROME_ARGS.join("\n"),
    AGENT_BROWSER_NO_WEBMCP: "1",
    AGENT_BROWSER_NO_AUTO_DIALOG: "1",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(15 * 60 * 1000),
    AGENT_BROWSER_DEFAULT_TIMEOUT: "20000",
    AGENT_BROWSER_MAX_OUTPUT: "200000",
  };
}

export const AGENT_BROWSER_CONFIG_FILE = Object.freeze({});

export function parsePidFile(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 1 ? pid : null;
}

export interface ProcessRow {
  readonly pid: number;
  readonly pgid: number;
  readonly command: string;
}

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match)
      rows.push({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] as string });
  }
  return rows;
}

export interface BrowserProcessQuery {
  readonly profile: string;
  readonly daemon: number | null;
  readonly self: number;
}

function usesProfile(command: string, profile: string): boolean {
  const flag = `--user-data-dir=${profile}`;
  const at = command.indexOf(flag);
  if (at < 0) return false;
  const next = command.charAt(at + flag.length);
  return next === "" || next === " ";
}

export function browserProcesses(
  rows: readonly ProcessRow[],
  query: BrowserProcessQuery,
): number[] {
  const ownGroup = rows.find((row) => row.pid === query.self)?.pgid ?? query.self;
  const targets = new Set<number>();
  for (const row of rows) {
    if (row.pid === query.self || !usesProfile(row.command, query.profile)) continue;
    targets.add(row.pid);
    if (row.pgid > 1 && row.pgid !== ownGroup) targets.add(-row.pgid);
  }
  const daemon = rows.find((row) => row.pid === query.daemon);
  if (daemon && daemon.pid !== query.self && daemon.command.includes("agent-browser"))
    targets.add(daemon.pid);
  return [...targets];
}

export const STOP_CLOSE_MS = 400;
export const STOP_BUDGET_MS = 1000;
