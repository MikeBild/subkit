import { describe, expect, test } from "bun:test";
import {
  libraryOf,
  missingPostgresNotices,
  postgresNoticePaths,
  renderEngineNotices,
  renderPostgresNotices,
} from "./local-notices.ts";

const MAC_FILES = [
  "COPYRIGHT",
  "LICENSE",
  "bin/postgres",
  "dependency-notices/icu4c@79/0-LICENSE",
  "dependency-notices/icu4c@79/1-license.html",
  "dependency-notices/icu4c@79/2-LICENSE",
  "dependency-notices/libxml2/0-Copyright",
  "dependency-notices/lz4/0-LICENSE",
  "dependency-notices/openssl@3/0-LICENSE.txt",
  "dependency-notices/openssl@3/1-NOTICEREF_free.3ssl",
  "dependency-notices/zstd/0-LICENSE",
  "dependency-notices/zstd/1-COPYING",
];

describe("postgres notices", () => {
  test("keep the PostgreSQL license and the license texts of the bundled libraries", () => {
    expect(postgresNoticePaths(MAC_FILES)).toEqual([
      "COPYRIGHT",
      "LICENSE",
      "dependency-notices/icu4c@79/0-LICENSE",
      "dependency-notices/icu4c@79/2-LICENSE",
      "dependency-notices/libxml2/0-Copyright",
      "dependency-notices/lz4/0-LICENSE",
      "dependency-notices/openssl@3/0-LICENSE.txt",
      "dependency-notices/zstd/0-LICENSE",
      "dependency-notices/zstd/1-COPYING",
    ]);
    expect(libraryOf("dependency-notices/openssl@3/1-NOTICEREF_free.3ssl")).toBeNull();
  });

  test("name every required notice that is missing", () => {
    expect(missingPostgresNotices(MAC_FILES)).toEqual([]);
    expect(
      missingPostgresNotices(MAC_FILES.filter((path) => !/COPYRIGHT|lz4|icu4c/.test(path))),
    ).toEqual(["PostgreSQL COPYRIGHT", "icu", "lz4"]);
  });

  test("render a titled section per file", () => {
    const text = renderPostgresNotices("18.7.0", [
      { path: "COPYRIGHT", text: "PostgreSQL Database Management System\n" },
      { path: "dependency-notices/zstd/0-LICENSE", text: "BSD License\n" },
    ]);
    expect(text).toContain("PostgreSQL 18.7.0");
    expect(text).toContain(
      "--- PostgreSQL License (COPYRIGHT) ---\nPostgreSQL Database Management System",
    );
    expect(text).toContain("--- zstd: dependency-notices/zstd/0-LICENSE ---\nBSD License");
    expect(renderEngineNotices("  pkg notice  ")).toContain("Resources/local/engine)\n");
  });
});
