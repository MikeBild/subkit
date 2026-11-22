import { describe, expect, test } from "bun:test";
import { PATH_CASES, SECRET_FILE_NAMES } from "./paths.cases.ts";
import {
  classifyNewEntry,
  classifyOpenedFile,
  classifyPath,
  classifyReadVersion,
  classifyRecheck,
  classifyRelativePath,
  classifyRoot,
  classifyRootIdentity,
  classifySize,
  DARWIN_SYSTEM_ROOTS,
  FILE_LIMITS,
  type FileVersion,
  fileVersionTag,
  hasProgramExtension,
  isExecutable,
  isSecretFile,
  PROGRAM_EXTENSIONS,
  PROTECTED_SEGMENTS,
  SECRET_EXTENSIONS,
  segmentsUnder,
  WINDOWS_SYSTEM_ROOTS,
} from "./paths.ts";
import type { PolicyResult } from "./result.ts";

function outcome(result: PolicyResult): string {
  return result.ok ? "ok" : result.code;
}

describe("the fixed path lists", () => {
  test("every secret and program extension is recognized", () => {
    for (const ext of SECRET_EXTENSIONS)
      expect([ext, isSecretFile(`a.${ext}`)]).toEqual([ext, true]);
    for (const ext of PROGRAM_EXTENSIONS) {
      expect([ext, hasProgramExtension(`a.${ext.toUpperCase()}`)]).toEqual([ext, true]);
    }
  });

  test("every protected segment is refused anywhere in a path", () => {
    for (const segment of PROTECTED_SEGMENTS) {
      expect([
        segment,
        outcome(classifyRelativePath(`a/${segment.toUpperCase()}/b`, "darwin")),
      ]).toEqual([segment, "outside_allowance"]);
    }
  });

  test("every system root is refused as an allowed folder", () => {
    for (const root of DARWIN_SYSTEM_ROOTS) {
      expect([root, outcome(classifyRoot(`/${root}/x`, { os: "darwin" }))]).toEqual([
        root,
        "outside_allowance",
      ]);
    }
    for (const root of WINDOWS_SYSTEM_ROOTS) {
      expect([root, outcome(classifyRoot(`C:\\${root}\\x`, { os: "win32" }))]).toEqual([
        root,
        "outside_allowance",
      ]);
    }
  });

  test("secret name patterns are anchored", () => {
    const notSecret = [
      "xenv",
      "env.txt",
      "xid_rsa",
      "x.tfstate.backup.old",
      "credentials.csv.bak",
      "xcredentials.csv",
      "credentials2",
      "xcredentials",
      "service-account.json.txt",
      "xservice-account.json",
      "client_secret.json.txt",
      "xclient_secret.json",
      "a-key.txt.bak",
      "wallet.dat.bak",
      "xwallet.dat",
      "xutc--2021-01",
      "netrc.bak",
      "xnetrc",
      "pgpass.bak",
      "xpgpass",
      "npmrc.bak",
      "xnpmrc",
      "git-credentials.bak",
      "xgit-credentials",
    ];
    for (const name of notSecret) expect([name, isSecretFile(name)]).toEqual([name, false]);
    expect(isSecretFile("server.pem. .")).toBe(true);
    expect(isSecretFile("server.pem.")).toBe(true);
  });
});

describe("path parsing details", () => {
  test("Windows names: device names only as a whole name, spaces are fine inside", () => {
    expect(outcome(classifyRelativePath("bacon.txt", "win32"))).toBe("ok");
    expect(outcome(classifyRelativePath("a b.txt", "win32"))).toBe("ok");
    expect(outcome(classifyRelativePath("sub\\", "win32"))).toBe("ok");
    expect(outcome(classifyRelativePath("sub/", "win32"))).toBe("ok");
    expect(outcome(classifyRelativePath("\\x", "win32"))).toBe("outside_allowance");
    expect(outcome(classifyRelativePath("/x", "win32"))).toBe("outside_allowance");
    expect(outcome(classifyRelativePath("C:x", "win32"))).toBe("outside_allowance");
    expect(outcome(classifyRelativePath("\\x", "darwin"))).toBe("ok");
    expect(outcome(classifyRelativePath("a\\..\\b", "darwin"))).toBe("ok");
    expect(outcome(classifyRelativePath("\u0000", "darwin"))).toBe("outside_allowance");
  });

  test("Windows absolute forms", () => {
    const win = { os: "win32" as const };
    expect(
      outcome(classifyPath("a.txt", "C:/Users/mike/Docs/a.txt", "C:\\Users\\mike\\Docs", win)),
    ).toBe("ok");
    expect(outcome(classifyRecheck("C:", "c:\\", win))).toBe("ok");
    expect(outcome(classifyRecheck("Docs\\C:\\a", "d:\\cs\\C:\\a", win))).toBe("path_moved");
    expect(outcome(classifyRecheck("\\\\?\\unc\\nas\\t\\a", "\\\\NAS\\T\\a", win))).toBe("ok");
    expect(outcome(classifyRecheck("\\\\?\\c:\\a", "C:\\a", win))).toBe("ok");
    expect(outcome(classifyRecheck("\\\\nas", "\\\\nas", win))).toBe("path_moved");
    expect(outcome(classifyRecheck("\\\\nas\\t\\..\\x", "\\\\nas\\t\\x", win))).toBe("path_moved");
    expect(outcome(classifyRecheck("1:\\a", "1:\\a", win))).toBe("path_moved");
    expect(outcome(classifyRecheck("\\\\nas\\t", "\\\\nas\\t", win))).toBe("ok");
    expect(outcome(classifyRecheck("\\\\nas\\t\\a", "\\\\other\\x\\a", win))).toBe("path_moved");
    expect(outcome(classifyRecheck("Do\\C:\\a", "Do\\C:\\a", win))).toBe("path_moved");
  });

  test("an unparseable root or data folder never widens access", () => {
    const mac = { os: "darwin" as const };
    expect(outcome(classifyPath("a.txt", "/r/a.txt", "relative", mac))).toBe("outside_allowance");
    expect(outcome(classifyPath("a.txt", "/r/a.txt", "/r", { ...mac, data_dir: "relative" }))).toBe(
      "ok",
    );
  });

  test("a case-sensitive volume compares data and home folders exactly", () => {
    const sensitive = { os: "darwin" as const, case_sensitive: true };
    expect(
      outcome(
        classifyPath("subkit/x", "/r/subkit/x", "/r", { ...sensitive, data_dir: "/r/SubKit" }),
      ),
    ).toBe("ok");
    expect(
      outcome(classifyRoot("/Users/mike/Docs", { ...sensitive, home: "/users/mike/docs/x" })),
    ).toBe("ok");
    expect(
      outcome(classifyRoot("/Users/mike/Docs", { ...sensitive, data_dir: "/users/mike/docs/x" })),
    ).toBe("ok");
  });

  test("new names on Windows", () => {
    expect(outcome(classifyNewEntry("report.pdf", "win32"))).toBe("ok");
    expect(outcome(classifyNewEntry("my.run.sh", "darwin", "old.sh"))).toBe("ok");
    expect(outcome(classifyNewEntry("run.sh", "darwin", "old.run"))).toBe("executable");
    expect(outcome(classifyNewEntry("run.sh", "darwin", "sh"))).toBe("executable");
  });

  test("a root is compared with home and data folders only when they are given", () => {
    expect(
      outcome(classifyRoot("/Users/mike/Docs", { os: "darwin", home: "/Users/mike/Docs/x" })),
    ).toBe("outside_allowance");
    expect(outcome(classifyRoot("/Users/mike/Docs", { os: "darwin" }))).toBe("ok");
    expect(
      outcome(classifyRoot("/Users/mike/Docs", { os: "darwin", data_dir: "/Users/mike/Docs" })),
    ).toBe("outside_allowance");
    expect(outcome(classifyRoot("/Volumes/Data/x", { os: "darwin" }))).toBe("ok");
    expect(outcome(classifyRoot("/Users", { os: "win32" }))).toBe("outside_allowance");
    expect(outcome(classifyRoot("C:\\Data", { os: "win32" }))).toBe("ok");
    expect(outcome(classifyRoot("C:\\Data\\Volumes", { os: "win32" }))).toBe("ok");
    expect(outcome(classifyRoot("D:\\Volumes", { os: "win32" }))).toBe("ok");
  });
});

describe("path cases", () => {
  test("cover both directions and both systems", () => {
    expect(PATH_CASES.length).toBeGreaterThanOrEqual(150);
    expect(new Set(PATH_CASES.map((c) => c.id)).size).toBe(PATH_CASES.length);
    for (const direction of ["over_permission", "needless_ask"]) {
      for (const os of ["darwin", "win32"]) {
        expect(PATH_CASES.some((c) => c.direction === direction && c.os === os)).toBe(true);
      }
    }
  });

  for (const c of PATH_CASES) {
    test(`${c.id} → ${c.expected}`, () => {
      const options = {
        os: c.os,
        ...(c.case_sensitive === undefined ? {} : { case_sensitive: c.case_sensitive }),
        ...(c.data_dir === undefined ? {} : { data_dir: c.data_dir }),
      };
      expect(outcome(classifyPath(c.lexical, c.real, c.root, options))).toBe(c.expected);
    });
  }
});

describe("relative paths", () => {
  test("refuse absolute, parent and NUL forms before anything else", () => {
    expect(outcome(classifyRelativePath("/a", "darwin"))).toBe("outside_allowance");
    expect(outcome(classifyRelativePath("a\u0000", "win32"))).toBe("outside_allowance");
    expect(outcome(classifyRelativePath("a/..", "darwin"))).toBe("outside_allowance");
    expect(outcome(classifyRelativePath("a/b", "darwin"))).toBe("ok");
  });

  test("a NUL byte inside a segment is refused on macOS too", () => {
    expect(outcome(classifyPath("a", "/r/a\u0000b", "/r", { os: "darwin" }))).toBe(
      "outside_allowance",
    );
  });

  test("only Windows treats colon, trailing dots and reserved names as tricks", () => {
    expect(outcome(classifyRelativePath("a:b", "darwin"))).toBe("ok");
    expect(outcome(classifyRelativePath("con", "darwin"))).toBe("ok");
    expect(outcome(classifyRelativePath("a. ", "darwin"))).toBe("ok");
    expect(outcome(classifyRelativePath("a~1", "darwin"))).toBe("ok");
    expect(outcome(classifyRelativePath("a~1", "win32"))).toBe("outside_allowance");
    expect(outcome(classifyRelativePath("console.log", "win32"))).toBe("ok");
  });
});

describe("secret and program files", () => {
  test("every listed secret pattern is recognized, case-insensitively", () => {
    for (const name of SECRET_FILE_NAMES) {
      expect(isSecretFile(name)).toBe(true);
      expect(isSecretFile(name.toUpperCase())).toBe(true);
    }
    expect(isSecretFile(".env.production")).toBe(true);
    expect(isSecretFile(".pgpass")).toBe(true);
    expect(isSecretFile("pem")).toBe(false);
    expect(isSecretFile("readme.")).toBe(false);
    expect(isSecretFile("a.keyx")).toBe(false);
  });

  test("programs are recognized by extension or by an execute bit", () => {
    expect(isExecutable("setup.exe", null)).toBe(true);
    expect(isExecutable("Run.COMMAND", 0o644)).toBe(true);
    expect(isExecutable("tool", 0o755)).toBe(true);
    expect(isExecutable("tool", 0o744)).toBe(true);
    expect(isExecutable("tool", 0o654)).toBe(true);
    expect(isExecutable("tool", 0o645)).toBe(true);
    expect(isExecutable("tool", 0o644)).toBe(false);
    expect(isExecutable("report.pdf", null)).toBe(false);
    expect(isExecutable(".exe", null)).toBe(false);
    expect(hasProgramExtension("evil.exe. ")).toBe(true);
    expect(hasProgramExtension("archive.tar.gz")).toBe(false);
  });
});

describe("allowed roots", () => {
  const home = "/Users/mike";
  const data = "/Users/mike/Library/Application Support/SubKit";

  test("ordinary folders inside the home folder are allowed", () => {
    expect(outcome(classifyRoot("/Users/mike/Documents", { os: "darwin", home }))).toBe("ok");
    expect(outcome(classifyRoot("/Volumes/Data/Projects", { os: "darwin" }))).toBe("ok");
    expect(outcome(classifyRoot("D:\\Projects", { os: "win32" }))).toBe("ok");
    expect(outcome(classifyRoot("C:\\Users\\mike\\Documents", { os: "win32" }))).toBe("ok");
  });

  test("the disk root, home itself, its parents and system folders are refused", () => {
    const refused: readonly [string, "darwin" | "win32"][] = [
      ["/", "darwin"],
      ["/Users/mike", "darwin"],
      ["/users/MIKE", "darwin"],
      ["/Users", "darwin"],
      ["/System/Library", "darwin"],
      ["/Library/Preferences", "darwin"],
      ["/private/var/folders", "darwin"],
      ["/usr/local", "darwin"],
      ["/etc", "darwin"],
      ["/Applications", "darwin"],
      ["/Volumes", "darwin"],
      ["/Volumes/Backup", "darwin"],
      ["/Users/mike/Library/Mail", "darwin"],
      ["/Volumes/TM/Backups.backupdb/Mac", "darwin"],
      ["relative/path", "darwin"],
      ["C:\\", "win32"],
      ["C:\\Windows\\System32", "win32"],
      ["C:\\Program Files\\App", "win32"],
      ["c:\\program files (x86)", "win32"],
      ["C:\\ProgramData", "win32"],
      ["C:\\Users", "win32"],
      ["C:\\Users\\mike\\AppData\\Local", "win32"],
      ["\\\\nas\\share", "win32"],
    ];
    for (const [root, os] of refused) {
      expect(outcome(classifyRoot(root, { os, home }))).toBe("outside_allowance");
    }
  });

  test("a root that contains or sits inside the SubKit data folder is refused", () => {
    expect(outcome(classifyRoot("/Users/mike/Projects", { os: "darwin", data_dir: data }))).toBe(
      "ok",
    );
    expect(
      outcome(
        classifyRoot("/Users/mike/Projects", {
          os: "darwin",
          data_dir: "/Users/mike/Projects/subkit",
        }),
      ),
    ).toBe("outside_allowance");
    expect(
      outcome(
        classifyRoot("/Users/mike/Projects/subkit/files", {
          os: "darwin",
          data_dir: "/Users/mike/Projects/subkit",
        }),
      ),
    ).toBe("outside_allowance");
    expect(
      outcome(classifyRoot("/Users/mike/Projects", { os: "darwin", data_dir: "relative" })),
    ).toBe("ok");
    expect(outcome(classifyRoot("/Users/mike/Projects", { os: "darwin", home: "relative" }))).toBe(
      "ok",
    );
    expect(
      outcome(classifyRoot("/Users/mike/Projects", { os: "darwin", home: null, data_dir: null })),
    ).toBe("ok");
  });

  test("hidden roots are refused, and only the disk-root depth of volumes", () => {
    expect(outcome(classifyRoot("/Users/mike/.config", { os: "darwin" }))).toBe("hidden_path");
    expect(outcome(classifyRoot("/Users/mike/notes", { os: "darwin" }))).toBe("ok");
    expect(outcome(classifyRoot("/Users/mike", { os: "darwin" }))).toBe("ok");
    expect(outcome(classifyRoot("/Volumes/Data/a/b", { os: "darwin" }))).toBe("ok");
    expect(outcome(classifyRoot("C:\\Users\\mike", { os: "win32" }))).toBe("ok");
    expect(outcome(classifyRoot("C:\\Data\\CON", { os: "win32" }))).toBe("outside_allowance");
  });
});

describe("new entries", () => {
  test("refuse empty, dot and nested names", () => {
    for (const name of ["", ".", ".."]) {
      expect(outcome(classifyNewEntry(name, "darwin"))).toBe("outside_allowance");
    }
    expect(outcome(classifyNewEntry("a/b", "darwin"))).toBe("outside_allowance");
    expect(outcome(classifyNewEntry("a\\b", "win32"))).toBe("outside_allowance");
    expect(outcome(classifyNewEntry("a/b", "win32"))).toBe("outside_allowance");
    expect(outcome(classifyNewEntry("a\\b", "darwin"))).toBe("ok");
  });

  test("refuse hidden, secret and program names unless a move keeps the extension", () => {
    expect(outcome(classifyNewEntry(".hidden", "darwin"))).toBe("hidden_path");
    expect(outcome(classifyNewEntry("id_rsa", "darwin"))).toBe("secret_file");
    expect(outcome(classifyNewEntry("run.sh", "darwin"))).toBe("executable");
    expect(outcome(classifyNewEntry("run.sh", "darwin", "old.sh"))).toBe("ok");
    expect(outcome(classifyNewEntry("run.SH", "darwin", "old.sh"))).toBe("ok");
    expect(outcome(classifyNewEntry("run.sh", "darwin", "old.txt"))).toBe("executable");
    expect(outcome(classifyNewEntry("report.pdf", "darwin"))).toBe("ok");
    expect(outcome(classifyNewEntry("report.pdf", "darwin", "x.exe"))).toBe("ok");
  });
});

describe("identity checks", () => {
  test("a replaced root is folder_changed", () => {
    expect(outcome(classifyRootIdentity("42", "42"))).toBe("ok");
    expect(outcome(classifyRootIdentity("42", "43"))).toBe("folder_changed");
  });

  test("an execution-time path that differs from the prepared one is path_moved", () => {
    const os = { os: "darwin" as const };
    expect(outcome(classifyRecheck("/r/a.txt", "/r/a.txt", os))).toBe("ok");
    expect(outcome(classifyRecheck("/r/a.txt", "/R/A.txt", os))).toBe("ok");
    expect(
      outcome(classifyRecheck("/r/a.txt", "/R/A.txt", { os: "darwin", case_sensitive: true })),
    ).toBe("path_moved");
    expect(outcome(classifyRecheck("/r/a.txt", "/r/b.txt", os))).toBe("path_moved");
    expect(outcome(classifyRecheck("/r/a.txt", "/r/a.txt/x", os))).toBe("path_moved");
    expect(outcome(classifyRecheck("/r/a/x", "/r/a", os))).toBe("path_moved");
    expect(outcome(classifyRecheck("r/a.txt", "/r/a.txt", os))).toBe("path_moved");
    expect(outcome(classifyRecheck("/r/a.txt", "r/a.txt", os))).toBe("path_moved");
  });

  test("an opened file must be the checked file and must not be a hard link", () => {
    const same = { dev: 1, ino: 2 };
    expect(outcome(classifyOpenedFile({ path: same, opened: same, nlink: 1, is_file: true }))).toBe(
      "ok",
    );
    expect(
      outcome(
        classifyOpenedFile({ path: same, opened: { dev: 1, ino: 3 }, nlink: 1, is_file: true }),
      ),
    ).toBe("path_moved");
    expect(
      outcome(
        classifyOpenedFile({ path: same, opened: { dev: 9, ino: 2 }, nlink: 1, is_file: true }),
      ),
    ).toBe("path_moved");
    expect(outcome(classifyOpenedFile({ path: same, opened: same, nlink: 2, is_file: true }))).toBe(
      "outside_allowance",
    );
    expect(
      outcome(classifyOpenedFile({ path: same, opened: same, nlink: 5, is_file: false })),
    ).toBe("ok");
  });

  test("a version that changed during the read is stale", () => {
    const before: FileVersion = { dev: 1, ino: 2, size: 3, mtime_ms: 4, ctime_ms: 5 };
    expect(fileVersionTag(before)).toBe("1:2:3:4:5");
    expect(outcome(classifyReadVersion(before, { ...before }))).toBe("ok");
    for (const key of ["dev", "ino", "size", "mtime_ms", "ctime_ms"] as const) {
      expect(outcome(classifyReadVersion(before, { ...before, [key]: 99 }))).toBe("stale");
    }
  });
});

describe("limits", () => {
  test("match the plan", () => {
    expect(FILE_LIMITS).toEqual({
      list_entries: 500,
      read_text_bytes: 262_144,
      import_bytes: 94_371_840,
      write_bytes: 10_485_760,
      batch_items: 200,
      download_bytes: 94_371_840,
    });
  });

  test("allow up to the limit and refuse above, below zero or not a number", () => {
    expect(outcome(classifySize("list_entries", 500))).toBe("ok");
    expect(outcome(classifySize("list_entries", 501))).toBe("too_large");
    expect(outcome(classifySize("write_bytes", 0))).toBe("ok");
    expect(outcome(classifySize("write_bytes", -1))).toBe("too_large");
    expect(outcome(classifySize("write_bytes", Number.NaN))).toBe("too_large");
    expect(outcome(classifySize("write_bytes", Number.POSITIVE_INFINITY))).toBe("too_large");
    expect(outcome(classifySize("download_bytes", 0))).toBe("too_large");
    expect(outcome(classifySize("download_bytes", 1))).toBe("ok");
    expect(outcome(classifySize("download_bytes", FILE_LIMITS.download_bytes + 1))).toBe(
      "too_large",
    );
  });
});

describe("containment", () => {
  const mac = { os: "darwin" as const };

  test("names the segments below the root, an empty list for the root itself", () => {
    expect(segmentsUnder("/app/root", "/app/root/fonts/a.woff2", mac)).toEqual([
      "fonts",
      "a.woff2",
    ]);
    expect(segmentsUnder("/app/root/", "/app/root/index.html", mac)).toEqual(["index.html"]);
    expect(segmentsUnder("/app/root", "/app/root", mac)).toEqual([]);
    expect(segmentsUnder("/app/root", "/app/root/..x/a", mac)).toEqual(["..x", "a"]);
  });

  test("anything beside, above or climbing out is not under the root", () => {
    expect(segmentsUnder("/app/root", "/app/root-other/index.html", mac)).toBeNull();
    expect(segmentsUnder("/app/root", "/app", mac)).toBeNull();
    expect(segmentsUnder("/app/root", "/app/root/../main.cjs", mac)).toBeNull();
    expect(segmentsUnder("/app/root", "/etc/passwd", mac)).toBeNull();
    expect(segmentsUnder("/app/root", "relative/a", mac)).toBeNull();
    expect(segmentsUnder("relative", "/relative/a", mac)).toBeNull();
  });

  test("case follows the volume", () => {
    expect(segmentsUnder("/App/Root", "/app/root/a", mac)).toEqual(["a"]);
    expect(segmentsUnder("/App/Root", "/app/root/a", { ...mac, case_sensitive: true })).toBeNull();
  });
});
