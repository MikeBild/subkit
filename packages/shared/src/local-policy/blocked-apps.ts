import type { DeviceCommandKind, DeviceOs } from "../device/protocol.ts";

export type AppCategory =
  | "subkit"
  | "terminal"
  | "automation"
  | "system"
  | "security_prompt"
  | "file_manager"
  | "remote_support"
  | "password_manager"
  | "crypto_wallet"
  | "payment_banking"
  | "browser"
  | "code_editor";

export type AppAccess = "full" | "view_only" | "blocked";

export interface AppClassification {
  readonly access: AppAccess;
  readonly category: AppCategory | null;
}

const VIEW_ONLY: ReadonlySet<AppCategory> = new Set(["browser", "code_editor"]);

const BUNDLES: Readonly<Record<AppCategory, readonly string[]>> = {
  subkit: ["dev.mikebild.subkit."],
  terminal: [
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "dev.warp.",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "com.github.wez.wezterm",
    "co.zeit.hyper",
    "com.mitchellh.ghostty",
    "org.tabby",
    "com.microsoft.windowsterminal",
  ],
  automation: [
    "com.apple.scripteditor2",
    "com.apple.automator",
    "com.apple.shortcuts",
    "com.apple.automator.runner",
    "com.runningwithcrayons.alfred",
    "com.raycast.macos",
    "com.stairways.keyboardmaestro.",
    "org.hammerspoon.hammerspoon",
    "com.hegenberg.bettertouchtool",
    "com.apple.systemevents",
    "org.python.",
    "com.apple.scriptmenuapp",
  ],
  system: [
    "com.apple.systempreferences",
    "com.apple.settings",
    "com.apple.activitymonitor",
    "com.apple.diskutility",
    "com.apple.keychainaccess",
    "com.apple.installer",
    "com.apple.migrateassistant",
    "com.apple.bootcampassistant",
    "com.apple.directoryutility",
    "com.apple.console",
    "com.apple.passwords",
    "com.apple.systemprofiler",
    "com.apple.softwareupdate",
    "com.apple.dock",
    "com.apple.controlcenter",
    "com.apple.notificationcenterui",
    "com.apple.systemuiserver",
    "com.apple.spotlight",
  ],
  security_prompt: [
    "com.apple.securityagent",
    "com.apple.loginwindow",
    "com.apple.coreservicesuiagent",
    "com.apple.usernotificationcenter",
    "com.apple.screensaver",
    "com.apple.authorizationhost",
    "com.apple.tccd",
    "com.apple.universalaccessauthwarn",
    "com.apple.localauthentication",
  ],
  file_manager: [
    "com.apple.finder",
    "com.cocoatech.pathfinder",
    "com.binarynights.forklift",
    "com.apple.appkit.xpc.openandsavepanelservice",
    "com.eltima.cmd1",
  ],
  remote_support: [
    "com.teamviewer.",
    "com.philandro.anydesk",
    "com.apple.screensharing",
    "com.apple.remotedesktop",
    "com.microsoft.rdc",
    "com.rustdesk.",
    "com.splashtop.",
    "com.logmein.",
    "com.realvnc.",
    "tv.parsec.",
    "com.google.chromeremotedesktop",
  ],
  password_manager: [
    "com.1password.",
    "com.agilebits.",
    "com.bitwarden.",
    "org.keepassxc.",
    "com.lastpass.",
    "com.dashlane.",
    "in.sinew.enpass",
    "me.proton.pass",
    "com.nordpass.",
    "com.siber.roboform",
    "com.keepersecurity.",
    "com.markmcguill.strongbox",
    "com.hicknhacksoftware.macpass",
  ],
  crypto_wallet: [
    "com.ledger.live",
    "io.trezor.",
    "com.exodus.",
    "org.electrum.",
    "io.metamask.",
    "io.wasabiwallet.",
    "com.sparrowwallet.",
    "io.atomicwallet",
    "com.coinbase.",
    "org.bitcoincore.",
    "org.bitcoin.",
    "com.trustwallet.",
  ],
  payment_banking: [
    "com.moneymoney-app.",
    "com.starfinanz.",
    "com.stoegerit.outbank",
    "de.subsembly.",
    "com.paypal.",
    "com.transferwise.",
    "com.revolut.",
    "de.number26.",
    "com.bunq.",
    "com.intuit.quicken",
    "de.finanzguru.",
    "de.buhl.finanzblick",
    "de.comdirect.",
    "de.dkb.",
    "de.ing.",
    "de.consorsbank.",
    "de.sparkasse.",
  ],
  browser: [
    "com.apple.safari",
    "com.google.chrome",
    "com.google.chrome.",
    "org.mozilla.",
    "com.microsoft.edgemac",
    "com.microsoft.edgemac.",
    "com.brave.browser",
    "com.brave.browser.",
    "company.thebrowser.",
    "com.operasoftware.",
    "com.vivaldi.",
    "org.chromium.",
    "com.kagi.kagimacos",
    "org.torproject.",
    "com.duckduckgo.",
    "app.zen-browser.",
  ],
  code_editor: [
    "com.microsoft.vscode",
    "com.microsoft.vscodeinsiders",
    "com.todesktop.",
    "com.exafunction.windsurf",
    "dev.zed.",
    "com.sublimetext.",
    "com.apple.dt.xcode",
    "com.google.android.studio",
    "com.jetbrains.",
    "com.panic.nova",
    "com.barebones.bbedit",
    "com.macromates.textmate",
    "org.vim.",
    "org.gnu.emacs",
    "com.github.atom",
  ],
};

const NAMES: Readonly<Record<AppCategory, readonly string[]>> = {
  subkit: ["subkit", "subkit dev", "subkit helper"],
  terminal: [
    "terminal",
    "iterm",
    "iterm2",
    "warp",
    "kitty",
    "alacritty",
    "wezterm",
    "wezterm-gui",
    "hyper",
    "ghostty",
    "tabby",
    "cmd",
    "powershell",
    "powershell_ise",
    "pwsh",
    "windowsterminal",
    "windows terminal",
    "wt",
    "conhost",
    "openconsole",
    "bash",
    "zsh",
    "sh",
    "fish",
    "wsl",
    "wslhost",
    "mintty",
    "git-bash",
    "putty",
  ],
  automation: [
    "script editor",
    "skripteditor",
    "automator",
    "shortcuts",
    "kurzbefehle",
    "alfred",
    "raycast",
    "keyboard maestro",
    "keyboard maestro engine",
    "hammerspoon",
    "bettertouchtool",
    "osascript",
    "python",
    "python3",
    "pythonw",
    "py",
    "node",
    "bun",
    "deno",
    "ruby",
    "perl",
    "java",
    "javaw",
    "wscript",
    "cscript",
    "mshta",
    "rundll32",
    "regsvr32",
    "autohotkey",
    "autohotkey64",
    "autoit3",
    "powertoys",
    "powertoys.run",
    "powerautomate",
    "power automate",
    "launchy",
    "keypirinha",
    "flow.launcher",
    "wox",
  ],
  system: [
    "system settings",
    "system preferences",
    "systemeinstellungen",
    "control",
    "control panel",
    "systemsettings",
    "regedit",
    "regedt32",
    "mmc",
    "taskmgr",
    "task manager",
    "activity monitor",
    "aktivitätsanzeige",
    "disk utility",
    "festplattendienstprogramm",
    "keychain access",
    "schlüsselbundverwaltung",
    "passwords",
    "passwörter",
    "installer",
    "installationsprogramm",
    "msiexec",
    "setup",
    "install",
    "uninstall",
    "migration assistant",
    "boot camp assistant",
    "directory utility",
    "console",
    "msconfig",
    "gpedit",
    "secpol",
    "services",
    "resmon",
    "perfmon",
    "compmgmt",
    "diskmgmt",
    "devmgmt",
    "eventvwr",
    "useraccountcontrolsettings",
    "software update",
    "dock",
    "control center",
    "spotlight",
  ],
  security_prompt: [
    "securityagent",
    "loginwindow",
    "coreservicesuiagent",
    "usernotificationcenter",
    "consent",
    "logonui",
    "lockapp",
    "credentialuibroker",
    "screensaverengine",
    "authorizationhost",
    "universalaccessauthwarn",
  ],
  file_manager: [
    "finder",
    "explorer",
    "file explorer",
    "path finder",
    "forklift",
    "commander one",
    "totalcmd",
    "totalcmd64",
    "total commander",
    "dopus",
    "directory opus",
    "files",
    "openandsavepanelservice",
    "open and save panel service",
  ],
  remote_support: [
    "teamviewer",
    "anydesk",
    "quickassist",
    "quick assist",
    "mstsc",
    "remote desktop connection",
    "microsoft remote desktop",
    "windows app",
    "screen sharing",
    "bildschirmfreigabe",
    "remote desktop",
    "chrome remote desktop",
    "rustdesk",
    "splashtop",
    "logmein",
    "vnc viewer",
    "realvnc",
    "parsec",
  ],
  password_manager: [
    "1password",
    "1password 7",
    "bitwarden",
    "keepass",
    "keepassxc",
    "keepassx",
    "lastpass",
    "dashlane",
    "enpass",
    "nordpass",
    "proton pass",
    "roboform",
    "keeper",
    "keeper password manager",
    "strongbox",
    "macpass",
    "secrets",
  ],
  crypto_wallet: [
    "ledger live",
    "trezor suite",
    "exodus",
    "electrum",
    "metamask",
    "wasabi wallet",
    "sparrow",
    "atomic wallet",
    "trust wallet",
    "bitcoin core",
    "bitcoin-qt",
    "monero gui",
    "monero-wallet-gui",
    "coinbase wallet",
  ],
  payment_banking: [
    "moneymoney",
    "starmoney",
    "outbank",
    "banking4",
    "banking 4",
    "finanzguru",
    "paypal",
    "wise",
    "revolut",
    "n26",
    "bunq",
    "quicken",
    "hibiscus",
    "subsembly banking",
    "numbrs",
    "finanzblick",
    "sparkasse",
    "comdirect",
    "dkb",
    "ing banking",
    "consorsbank",
  ],
  browser: [
    "safari",
    "google chrome",
    "chrome",
    "firefox",
    "microsoft edge",
    "msedge",
    "brave browser",
    "brave",
    "arc",
    "opera",
    "vivaldi",
    "chromium",
    "orion",
    "tor browser",
    "iexplore",
    "duckduckgo",
    "zen",
    "zen browser",
    "google chrome canary",
    "google chrome beta",
    "google chrome dev",
    "google chrome for testing",
    "chrome canary",
    "microsoft edge beta",
    "microsoft edge dev",
    "microsoft edge canary",
    "brave browser beta",
    "brave browser nightly",
    "firefox developer edition",
    "firefox nightly",
  ],
  code_editor: [
    "visual studio code",
    "code",
    "code - insiders",
    "visual studio code - insiders",
    "cursor",
    "windsurf",
    "zed",
    "sublime text",
    "sublime_text",
    "xcode",
    "android studio",
    "intellij idea",
    "idea",
    "idea64",
    "webstorm",
    "webstorm64",
    "pycharm",
    "pycharm64",
    "goland",
    "rider",
    "clion",
    "phpstorm",
    "rubymine",
    "datagrip",
    "fleet",
    "nova",
    "bbedit",
    "textmate",
    "vim",
    "macvim",
    "gvim",
    "nvim",
    "neovim",
    "emacs",
    "notepad++",
    "devenv",
    "visual studio",
    "eclipse",
    "atom",
  ],
};

export const BLOCKED_APP_BUNDLES = BUNDLES;
export const BLOCKED_APP_NAMES = NAMES;

const NAME_PATTERNS: readonly (readonly [RegExp, AppCategory])[] = [
  [/\b(online-?)?bank(ing)?\b/, "payment_banking"],
  [/\bwallet\b/, "crypto_wallet"],
  [/\bpasswor[dt]/, "password_manager"],
  [/\bterminal\b/, "terminal"],
  [/\bremote desktop\b/, "remote_support"],
  [/\binstall/, "system"],
];

const CATEGORY_ORDER: readonly AppCategory[] = [
  "subkit",
  "security_prompt",
  "password_manager",
  "crypto_wallet",
  "payment_banking",
  "terminal",
  "automation",
  "system",
  "remote_support",
  "file_manager",
  "browser",
  "code_editor",
];

function normalizeName(name: string | null, os: DeviceOs): string {
  return (name ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(os === "win32" ? /.*[\\/]/ : /.*\//, "")
    .replace(/\.(exe|app|com|bat|cmd|lnk)$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesBundle(bundleId: string, entry: string): boolean {
  return entry.endsWith(".") ? bundleId.startsWith(entry) : bundleId === entry;
}

function categoryOf(
  bundleId: string | null,
  name: string | null,
  os: DeviceOs,
): AppCategory | null {
  const bundle = bundleId?.trim().toLowerCase();
  const program = normalizeName(name, os);
  for (const category of CATEGORY_ORDER) {
    if (BUNDLES[category].some((entry) => bundle !== undefined && matchesBundle(bundle, entry))) {
      return category;
    }
    if (NAMES[category].includes(program)) return category;
  }
  for (const [pattern, category] of NAME_PATTERNS) {
    if (pattern.test(program)) return category;
  }
  return null;
}

export function classifyApp(
  bundleId: string | null,
  name: string | null,
  os: DeviceOs,
): AppClassification {
  if ((bundleId ?? "").trim() === "" && normalizeName(name, os) === "") {
    return { access: "blocked", category: null };
  }
  const category = categoryOf(bundleId, name, os);
  if (category === null) return { access: "full", category: null };
  return { access: VIEW_ONLY.has(category) ? "view_only" : "blocked", category };
}

export function isBlockedApp(bundleId: string | null, name: string | null, os: DeviceOs): boolean {
  return classifyApp(bundleId, name, os).access !== "full";
}

const OBSERVE_KINDS: ReadonlySet<DeviceCommandKind> = new Set([
  "computer.snapshot",
  "computer.find",
  "computer.screenshot",
  "computer.focus",
]);

export function computerActionAllowed(kind: DeviceCommandKind, access: AppAccess): boolean {
  if (!kind.startsWith("computer.")) return false;
  if (kind === "computer.apps") return true;
  if (access === "full") return true;
  if (access === "view_only") return OBSERVE_KINDS.has(kind) || kind === "computer.open";
  return false;
}

export const DARWIN_APP_MENU_EXACT: ReadonlySet<string> = new Set([
  "services",
  "dienste",
  "show all",
  "alle einblenden",
]);
export const DARWIN_APP_MENU_PREFIXES: readonly string[] = ["hide ", "quit "];
export const DARWIN_APP_MENU_SUFFIXES: readonly string[] = [" ausblenden", " beenden"];
export const DARWIN_APPLE_MENU: ReadonlySet<string> = new Set(["apple", "", ""]);
export const WINDOWS_SYSTEM_MENU: ReadonlySet<string> = new Set([
  "system",
  "system menu",
  "systemmenü",
  "window menu",
]);

function menuText(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function hiddenAppMenuItem(leaf: string): boolean {
  return (
    DARWIN_APP_MENU_EXACT.has(leaf) ||
    DARWIN_APP_MENU_PREFIXES.some((prefix) => leaf.startsWith(prefix)) ||
    DARWIN_APP_MENU_SUFFIXES.some((suffix) => leaf.endsWith(suffix))
  );
}

export function isHiddenMenuItem(path: readonly string[], appName: string, os: DeviceOs): boolean {
  const items = path.map(menuText);
  const top = items[0] ?? "";
  if (os === "win32") return WINDOWS_SYSTEM_MENU.has(top);
  if (DARWIN_APPLE_MENU.has(top)) return true;
  const leaf = items[1];
  return top === menuText(appName) && leaf !== undefined && hiddenAppMenuItem(leaf);
}
