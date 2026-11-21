import type { DeviceOs, DeviceRefusal } from "../device/protocol.ts";

export type CaseDirection = "over_permission" | "needless_ask";

export interface PathCase {
  readonly id: string;
  readonly direction: CaseDirection;
  readonly os: DeviceOs;
  readonly lexical: string;
  readonly real: string;
  readonly root: string;
  readonly case_sensitive?: boolean;
  readonly data_dir?: string;
  readonly expected: "ok" | DeviceRefusal;
}

const MAC_ROOT = "/Users/mike/Docs";
const WIN_ROOT = "C:\\Users\\mike\\Docs";

function mac(
  id: string,
  lexical: string,
  expected: "ok" | DeviceRefusal,
  real = `${MAC_ROOT}/${lexical}`,
  extra: Partial<PathCase> = {},
): PathCase {
  return {
    id: `mac-${id}`,
    direction: expected === "ok" ? "needless_ask" : "over_permission",
    os: "darwin",
    lexical,
    real,
    root: MAC_ROOT,
    expected,
    ...extra,
  };
}

function win(
  id: string,
  lexical: string,
  expected: "ok" | DeviceRefusal,
  real = `${WIN_ROOT}\\${lexical.replace(/\//g, "\\")}`,
  extra: Partial<PathCase> = {},
): PathCase {
  return {
    id: `win-${id}`,
    direction: expected === "ok" ? "needless_ask" : "over_permission",
    os: "win32",
    lexical,
    real,
    root: WIN_ROOT,
    expected,
    ...extra,
  };
}

export const SECRET_FILE_NAMES = [
  "server.pem",
  "SERVER.PEM",
  "prod.key",
  "cert.p12",
  "cert.pfx",
  "AuthKey_ABC.p8",
  "Passwords.kdbx",
  "old.kdb",
  "login.keychain",
  "login.keychain-db",
  "office.ovpn",
  "terraform.tfstate",
  "terraform.tfstate.backup",
  "release.jks",
  "android.keystore",
  "putty.ppk",
  "coins.wallet",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials.csv",
  "credentials-2026.csv",
  "credentials",
  "service-account.json",
  "service-account-prod.json",
  "client_secret_123.apps.json",
  "openai-key.txt",
  "wallet.dat",
  "UTC--2021-01-01T00-00-00.000Z--abcdef",
  "_netrc",
  "netrc",
  "pgpass",
  "npmrc",
  "git-credentials",
  "env",
] as const;

export const ORDINARY_FILE_NAMES = [
  "a.txt",
  "Rechnung-2026-01.pdf",
  "environment.md",
  "monkey.txt",
  "credentials.md",
  "pemberton.docx",
  "keys.xlsx",
  "my.env.example",
  "service-agreement.json",
  "id_card.pdf",
  "wallet-photo.jpg",
  "Steuer 2025.pdf",
  "Budget.numbers",
  "notes.key.md",
  "keyboard.png",
  "Über uns.docx",
] as const;

export const PATH_CASES: readonly PathCase[] = [
  mac("plain-file", "a.txt", "ok"),
  mac("root-itself-empty", "", "ok", MAC_ROOT),
  mac("root-itself-dot", ".", "ok", MAC_ROOT),
  mac("nested", "Rechnungen/2026/rechnung-01.pdf", "ok"),
  mac("dot-segment", "./a.txt", "ok", `${MAC_ROOT}/a.txt`),
  mac("double-slash", "sub//b.txt", "ok", `${MAC_ROOT}/sub/b.txt`),
  mac("trailing-slash-root", "a.txt", "ok", `${MAC_ROOT}/a.txt`, { root: `${MAC_ROOT}/` }),
  mac("case-insensitive-volume", "a.txt", "ok", "/users/MIKE/docs/a.txt"),
  mac("nfd-real-path", "Über/a.txt", "ok", "/Users/mike/Docs/U\u0308ber/a.txt"),
  mac("symlink-inside", "link/a.txt", "ok", `${MAC_ROOT}/real/a.txt`),
  mac("backslash-is-a-name-char", "a\\b.txt", "ok"),
  mac("tilde-is-a-name", "~notes.txt", "ok"),
  mac("dotdot-leading", "../x.txt", "outside_allowance", "/Users/mike/x.txt"),
  mac("dotdot-inner", "a/../../x.txt", "outside_allowance", "/Users/mike/x.txt"),
  mac("dotdot-only", "..", "outside_allowance", "/Users/mike"),
  mac("dotdot-resolves-inside", "a/../b.txt", "outside_allowance", `${MAC_ROOT}/b.txt`),
  mac("absolute-lexical", "/etc/passwd", "outside_allowance", "/etc/passwd"),
  mac("nul-byte", "a\u0000.txt", "outside_allowance"),
  mac("symlink-escape", "link/a.txt", "outside_allowance", "/Users/mike/Secret/a.txt"),
  mac("symlink-to-parent", "up", "outside_allowance", "/Users/mike"),
  mac("symlink-to-root", "disk", "outside_allowance", "/"),
  mac("prefix-confusion", "x/a.txt", "outside_allowance", "/Users/mike/Docsx/a.txt"),
  mac("real-relative", "a.txt", "outside_allowance", "Docs/a.txt"),
  mac("real-dotdot", "a.txt", "outside_allowance", `${MAC_ROOT}/../a.txt`),
  mac("case-sensitive-volume", "a.txt", "outside_allowance", "/Users/mike/docs/a.txt", {
    case_sensitive: true,
  }),
  mac("hidden-leaf", ".bashrc", "hidden_path"),
  mac("hidden-dir", ".ssh/config", "hidden_path"),
  mac("hidden-deep", "project/.git/config", "hidden_path"),
  mac("hidden-env", ".env", "hidden_path"),
  mac("hidden-real-via-symlink", "notes", "hidden_path", `${MAC_ROOT}/.secret/notes`),
  mac("library-segment", "Library/Keychains/x", "outside_allowance"),
  mac("library-lowercase", "library/x", "outside_allowance"),
  mac("library-real", "x", "outside_allowance", `${MAC_ROOT}/Library/x`),
  mac("time-machine", "Backups.backupdb/x", "outside_allowance"),
  mac("symlink-to-secret", "report.txt", "secret_file", `${MAC_ROOT}/keys/server.pem`),
  mac("secret-trailing-dot", "server.pem.", "secret_file", `${MAC_ROOT}/server.pem`),
  mac("key-file", "Vortrag.key", "secret_file"),
  mac("key-lexical", "Vortrag.key", "secret_file", `${MAC_ROOT}/Vortrag.pdf`),
  mac("key-real", "Vortrag.pdf", "secret_file", `${MAC_ROOT}/Vortrag.key`),
  mac("key-in-longer-extension", "Vortrag.keynote", "ok"),
  mac("data-dir", "SubKit/pgdata/x", "outside_allowance", `${MAC_ROOT}/SubKit/pgdata/x`, {
    data_dir: `${MAC_ROOT}/SubKit`,
  }),
  mac("data-dir-case", "subkit/x", "outside_allowance", `${MAC_ROOT}/subkit/x`, {
    data_dir: `${MAC_ROOT}/SubKit`,
  }),
  mac("next-to-data-dir", "SubKitNotes/x.txt", "ok", `${MAC_ROOT}/SubKitNotes/x.txt`, {
    data_dir: `${MAC_ROOT}/SubKit`,
  }),
  ...SECRET_FILE_NAMES.map((name) => mac(`secret-${name}`, `keys/${name}`, "secret_file")),
  ...ORDINARY_FILE_NAMES.map((name) => mac(`ordinary-${name}`, `docs/${name}`, "ok")),
  win("plain-file", "a.txt", "ok"),
  win("forward-slash", "sub/a.docx", "ok"),
  win("backslash", "sub\\a.docx", "ok"),
  win("case-insensitive", "a.txt", "ok", "c:\\users\\MIKE\\docs\\a.txt"),
  win("long-path-prefix", "a.txt", "ok", "\\\\?\\C:\\Users\\mike\\Docs\\a.txt"),
  win("long-path-root", "a.txt", "ok", `${WIN_ROOT}\\a.txt`, {
    root: "\\\\?\\C:\\Users\\mike\\Docs",
  }),
  win("unc-share", "a.txt", "ok", "\\\\nas\\team\\Docs\\a.txt", { root: "\\\\NAS\\team\\Docs" }),
  win("unc-long-prefix", "a.txt", "ok", "\\\\?\\UNC\\nas\\team\\Docs\\a.txt", {
    root: "\\\\nas\\team\\Docs",
  }),
  win("dotdot", "..\\x.txt", "outside_allowance", "C:\\Users\\mike\\x.txt"),
  win("dotdot-forward", "a/../../x.txt", "outside_allowance", "C:\\Users\\mike\\x.txt"),
  win("drive-absolute", "C:\\Windows\\win.ini", "outside_allowance", "C:\\Windows\\win.ini"),
  win("drive-relative", "D:x.txt", "outside_allowance", "D:\\x.txt"),
  win("rooted", "\\Windows\\x", "outside_allowance", "C:\\Windows\\x"),
  win("rooted-forward", "/Windows/x", "outside_allowance", "C:\\Windows\\x"),
  win("unc-lexical", "\\\\server\\share\\x", "outside_allowance", "\\\\server\\share\\x"),
  win("other-drive-real", "a.txt", "outside_allowance", "D:\\Users\\mike\\Docs\\a.txt"),
  win("junction-escape", "link\\a.txt", "outside_allowance", "C:\\Users\\mike\\Secret\\a.txt"),
  win("unc-escape", "link\\a.txt", "outside_allowance", "\\\\?\\UNC\\evil\\share\\a.txt"),
  win("prefix-confusion", "x\\a.txt", "outside_allowance", "C:\\Users\\mike\\Docs2\\a.txt"),
  win("unc-too-short", "a.txt", "outside_allowance", "\\\\server"),
  win("relative-real", "a.txt", "outside_allowance", "Docs\\a.txt"),
  win("alternate-stream", "a.txt:hidden", "outside_allowance"),
  win("trailing-dot", "server.pem.", "outside_allowance"),
  win("trailing-space", "report.pdf ", "outside_allowance"),
  win("reserved-con", "CON", "outside_allowance"),
  win("reserved-nul-ext", "nul.txt", "outside_allowance"),
  win("reserved-com1", "sub\\COM1.log", "outside_allowance"),
  win("reserved-lpt-superscript", "LPT¹", "outside_allowance"),
  win("reserved-conin", "CONIN$", "outside_allowance"),
  win("short-name", "PROGRA~1\\x", "outside_allowance"),
  win("illegal-char", "a<b.txt", "outside_allowance"),
  win("control-char", "a\u0001b.txt", "outside_allowance"),
  win("appdata", "AppData\\Roaming\\x", "outside_allowance"),
  win("recycle-bin", "$Recycle.Bin\\x", "outside_allowance"),
  win("system-volume", "System Volume Information\\x", "outside_allowance"),
  win("hidden", ".config\\x", "hidden_path"),
  win("junction-to-secret", "a.txt", "secret_file", `${WIN_ROOT}\\keys\\id_rsa`),
  ...SECRET_FILE_NAMES.map((name) => win(`secret-${name}`, `keys\\${name}`, "secret_file")),
  ...ORDINARY_FILE_NAMES.map((name) => win(`ordinary-${name}`, `docs\\${name}`, "ok")),
];

export interface PersonalPathCase {
  readonly id: string;
  readonly direction: CaseDirection;
  readonly os: DeviceOs;
  readonly lexical: string;
  readonly real: string;
  readonly keep_out: readonly string[];
  readonly data_dir?: string;
  readonly case_sensitive?: boolean;
  readonly expected: "ok" | DeviceRefusal;
}

const MAC_KEEP_OUT = ["/Users/mike/Private", "/Users/mike/Finanzen"];
const WIN_KEEP_OUT = ["C:\\Users\\mike\\Private"];

function personal(
  os: DeviceOs,
  id: string,
  real: string,
  expected: "ok" | DeviceRefusal,
  extra: Partial<PersonalPathCase> = {},
): PersonalPathCase {
  return {
    id: `ref-${os}-${id}`,
    direction: expected === "ok" ? "needless_ask" : "over_permission",
    os,
    lexical: real,
    real,
    keep_out: os === "darwin" ? MAC_KEEP_OUT : WIN_KEEP_OUT,
    expected,
    ...extra,
  };
}

export const PERSONAL_PATH_CASES: readonly PersonalPathCase[] = [
  personal("darwin", "documents", "/Users/mike/Documents/a.txt", "ok"),
  personal("darwin", "desktop", "/Users/mike/Desktop/Rechnung.pdf", "ok"),
  personal("darwin", "downloads", "/Users/mike/Downloads/report.xlsx", "ok"),
  personal("darwin", "external-volume", "/Volumes/Data/Projekte/a.txt", "ok"),
  personal("darwin", "next-to-keep-out", "/Users/mike/PrivateNotes/a.txt", "ok"),
  personal("darwin", "nfd-name", "/Users/mike/Documents/U\u0308bersicht.txt", "ok"),
  personal("darwin", "keep-out", "/Users/mike/Private/a.txt", "outside_allowance"),
  personal("darwin", "keep-out-itself", "/Users/mike/Private", "outside_allowance"),
  personal("darwin", "keep-out-case", "/users/MIKE/private/a.txt", "outside_allowance"),
  personal("darwin", "keep-out-second", "/Users/mike/Finanzen/2026/a.pdf", "outside_allowance"),
  personal("darwin", "keep-out-case-sensitive-other", "/Users/mike/private/a.txt", "ok", {
    case_sensitive: true,
  }),
  personal(
    "darwin",
    "symlink-into-keep-out",
    "/Users/mike/Documents/link.txt",
    "outside_allowance",
    {
      real: "/Users/mike/Private/a.txt",
    },
  ),
  personal("darwin", "lexical-in-keep-out", "/Users/mike/Private/link.txt", "outside_allowance", {
    real: "/Users/mike/Documents/a.txt",
  }),
  personal("darwin", "disk-root", "/", "outside_allowance"),
  personal("darwin", "relative", "Documents/a.txt", "outside_allowance"),
  personal("darwin", "dotdot", "/Users/mike/Documents/../Private/a.txt", "outside_allowance"),
  personal("darwin", "etc", "/etc/hosts", "outside_allowance"),
  personal("darwin", "system", "/System/Library/x", "outside_allowance"),
  personal("darwin", "private-var", "/private/var/db/x", "outside_allowance"),
  personal("darwin", "applications", "/Applications/Safari.app", "outside_allowance"),
  personal("darwin", "users-root", "/Users", "outside_allowance"),
  personal("darwin", "volume-root", "/Volumes/Data", "outside_allowance"),
  personal("darwin", "library", "/Users/mike/Library/Keychains/x", "outside_allowance"),
  personal("darwin", "hidden", "/Users/mike/.ssh/config", "hidden_path"),
  personal("darwin", "secret", "/Users/mike/Documents/server.pem", "secret_file"),
  personal("darwin", "key-file", "/Users/mike/Documents/Vortrag.key", "secret_file"),
  personal("darwin", "key-in-longer-extension", "/Users/mike/Documents/Vortrag.keynote", "ok"),
  personal("darwin", "data-dir", "/Users/mike/SubKit/pgdata/x", "outside_allowance", {
    data_dir: "/Users/mike/SubKit",
  }),
  personal("win32", "documents", "C:\\Users\\mike\\Documents\\a.txt", "ok"),
  personal("win32", "other-drive", "D:\\Projekte\\a.docx", "ok"),
  personal("win32", "share", "\\\\nas\\team\\a.txt", "ok"),
  personal("win32", "keep-out", "C:\\Users\\mike\\Private\\a.txt", "outside_allowance"),
  personal("win32", "keep-out-forward-slash", "c:/users/mike/private/a.txt", "outside_allowance"),
  personal("win32", "windows", "C:\\Windows\\System32\\x", "outside_allowance"),
  personal("win32", "program-files", "C:\\Program Files\\App\\x", "outside_allowance"),
  personal("win32", "appdata", "C:\\Users\\mike\\AppData\\Roaming\\x", "outside_allowance"),
  personal("win32", "drive-root", "C:\\", "outside_allowance"),
  personal("win32", "stream", "C:\\Users\\mike\\a.txt:hidden", "outside_allowance"),
  personal("win32", "secret", "C:\\Users\\mike\\Documents\\id_rsa", "secret_file"),
];
