import { describe, expect, test } from "bun:test";
import manifest from "../../../vendor/postgres.json";
import {
  keepBundlePath,
  linkProblems,
  POSTGRES_TARGETS,
  parseOtoolDependencies,
  programFile,
  stripTopFolder,
  targetFor,
} from "./postgres-bundle.ts";

describe("manifest", () => {
  test("pins every target to an exact asset of one PostgreSQL 18 release", () => {
    expect(manifest.major).toBe(18);
    expect(manifest.version.startsWith("18.")).toBe(true);
    for (const target of POSTGRES_TARGETS) {
      const asset = (
        manifest.targets as Record<string, { asset: string; sha256: string; bytes: number }>
      )[target];
      expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset?.bytes).toBeGreaterThan(10_000_000);
      expect(asset?.asset.startsWith(`postgresql-${manifest.version}-`)).toBe(true);
    }
  });
});

describe("target", () => {
  test("maps the running platform to a bundle", () => {
    expect(targetFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(targetFor("win32", "x64")).toBe("win32-x64");
    expect(targetFor("linux", "x64")).toBeNull();
    expect(programFile("win32-x64", "postgres")).toBe("bin/postgres.exe");
    expect(programFile("darwin-arm64", "pg_dump")).toBe("bin/pg_dump");
    expect(targetFor("darwin", "x64")).toBeNull();
  });
});

describe("pruning", () => {
  test("keeps the server, backup tools, pgcrypto and full-text search on macOS", () => {
    for (const kept of [
      "bin/postgres",
      "bin/initdb",
      "bin/pg_dump",
      "bin/pg_restore",
      "bin/pg_isready",
      "lib/pgcrypto.dylib",
      "lib/plpgsql.dylib",
      "lib/dict_snowball.dylib",
      "lib/euc_cn_and_mic.dylib",
      "lib/utf8_and_win.dylib",
      "lib/libpq.5.dylib",
      "lib/libicudata.79.dylib",
      "share/postgres.bki",
      "share/snowball_create.sql",
      "share/tsearch_data/english.stop",
      "share/timezone/Europe/Berlin",
      "share/extension/pgcrypto.control",
      "share/extension/pgcrypto--1.3.sql",
      "share/extension/plpgsql--1.0.sql",
      "dependency-notices/openssl@3/0-LICENSE.txt",
      "COPYRIGHT",
    ])
      expect(`${kept} ${keepBundlePath(kept, "darwin-arm64")}`).toBe(`${kept} true`);
  });

  test("drops GPL readline, psql, the LLVM JIT, Python, headers and unused extensions", () => {
    for (const dropped of [
      "bin/psql",
      "bin/pg_upgrade",
      "lib/libreadline.8.dylib",
      "lib/libLLVM.dylib",
      "lib/llvmjit.dylib",
      "lib/plpython3.dylib",
      "lib/Python",
      "lib/python3.13/os.py",
      "lib/libpq.a",
      "lib/bitcode/postgres.index.bc",
      "lib/hstore.dylib",
      "include/libpq-fe.h",
      "share/extension/hstore.control",
      "share/doc/extension/README",
      "dependency-notices/readline/0-COPYING",
      "dependency-notices/python@3.13/0-LICENSE",
      "dependency-notices/llvm@16/0-LICENSE.TXT",
    ])
      expect(`${dropped} ${keepBundlePath(dropped, "darwin-arm64")}`).toBe(`${dropped} false`);
  });

  test("keeps the programs and their DLLs on Windows, without Python", () => {
    expect(keepBundlePath("bin/postgres.exe", "win32-x64")).toBe(true);
    expect(keepBundlePath("bin/libpq.dll", "win32-x64")).toBe(true);
    expect(keepBundlePath("bin/icuuc79.dll", "win32-x64")).toBe(true);
    expect(keepBundlePath("lib/pgcrypto.dll", "win32-x64")).toBe(true);
    expect(keepBundlePath("bin/psql.exe", "win32-x64")).toBe(false);
    expect(keepBundlePath("bin/python315.dll", "win32-x64")).toBe(false);
    expect(keepBundlePath("lib/plpython3.dll", "win32-x64")).toBe(false);
    expect(keepBundlePath("lib/libpq.lib", "win32-x64")).toBe(false);
  });

  test("strips the archive's top folder and refuses traversal", () => {
    expect(stripTopFolder("postgresql-18.7.0-aarch64-apple-darwin/bin/postgres")).toBe(
      "bin/postgres",
    );
    expect(stripTopFolder("postgresql-18\\bin\\postgres.exe")).toBe("bin/postgres.exe");
    expect(stripTopFolder("top/../../etc/passwd")).toBeNull();
    expect(stripTopFolder("README")).toBeNull();
  });
});

describe("link check", () => {
  test("reads otool output", () => {
    expect(
      parseOtoolDependencies(
        [
          "bin/postgres:",
          "\t@loader_path/../lib/libzstd.1.dylib (compatibility version 1.0.0, current version 1.5.7)",
          "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)",
          "",
        ].join("\n"),
      ),
    ).toEqual(["@loader_path/../lib/libzstd.1.dylib", "/usr/lib/libSystem.B.dylib"]);
  });

  test("every bundled library resolves inside the bundle or the system", () => {
    const kept = new Set(["bin/postgres", "lib/libzstd.1.dylib", "lib/pgcrypto.dylib"]);
    expect(
      linkProblems(
        [
          {
            file: "bin/postgres",
            dependencies: ["@loader_path/../lib/libzstd.1.dylib", "/usr/lib/libz.1.dylib"],
          },
          { file: "lib/libzstd.1.dylib", dependencies: ["@loader_path/libzstd.1.dylib"] },
          { file: "lib/pgcrypto.dylib", dependencies: ["@loader_path/libcrypto.3.dylib"] },
          { file: "bin/initdb", dependencies: ["/opt/homebrew/lib/libicuuc.79.dylib"] },
        ],
        kept,
      ),
    ).toEqual([
      "bin/initdb links /opt/homebrew/lib/libicuuc.79.dylib outside the bundle",
      "lib/pgcrypto.dylib needs lib/libcrypto.3.dylib",
    ]);
  });
});
