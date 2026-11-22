import { describe, expect, test } from "bun:test";
import { findTypedVersions, TYPED_VERSION_SCOPE } from "../audit/typed-versions.ts";

describe("findTypedVersions", () => {
  test("finds versions typed into prose, code and file names", () => {
    expect(
      findTypedVersions(
        [
          "Needs a server of version 12.0.0 or later.",
          "Download `subkit-desktop-12.1.0-mac-arm64.dmg`.",
          "A pre-release such as `1.4.0-beta.1` and v2.3.4.",
          "Run `oven/bun:1.4.5-debian`.",
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, version: "12.0.0" },
      { line: 2, version: "12.1.0-mac" },
      { line: 3, version: "1.4.0-beta.1" },
      { line: 3, version: "v2.3.4" },
      { line: 4, version: "1.4.5-debian" },
    ]);
  });

  test("ignores tokens, addresses, two-part numbers and grouped digits", () => {
    expect(
      findTypedVersions(
        [
          "Needs @@DESKTOP_MIN_SERVER_VERSION@@ or later.",
          "Listen on 127.0.0.1 or 0.0.0.0.",
          "OpenAPI 3.1, Apache License 2.0, 1.5 times.",
          "Bis zu 1.000.000 Zeilen.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("skips the release history region", () => {
    expect(
      findTypedVersions(
        [
          "<!-- release-history -->",
          "| Web Clipper | 9.9.0 |",
          "<!-- /release-history -->",
          "Since 9.9.0.",
        ].join("\n"),
      ),
    ).toEqual([{ line: 4, version: "9.9.0" }]);
  });

  test("reports a release history region that never ends", () => {
    expect(findTypedVersions("intro\n<!-- release-history -->\n| A | 1.0.0 |")).toEqual([
      { line: 2, version: "unclosed release history" },
    ]);
  });
});

describe("TYPED_VERSION_SCOPE", () => {
  test("covers the README, both doc languages and the clipper pages", () => {
    for (const file of [
      "README.md",
      "apps/engine/src/http/reference/web-clipper.de.md",
      "apps/engine/src/http/reference/web-clipper.en.md",
      "apps/clipper/public/manifest.json",
      "apps/clipper/public/popup.html",
    ]) {
      expect(TYPED_VERSION_SCOPE.test(file)).toBe(true);
    }
  });

  test("leaves the changelog, generated docs and other files out", () => {
    for (const file of [
      "CHANGELOG.md",
      "apps/engine/src/http/llms/llms-full.txt",
      "apps/engine/src/http/reference/images/manifest.json",
      "apps/desktop/README.md",
    ]) {
      expect(TYPED_VERSION_SCOPE.test(file)).toBe(false);
    }
  });
});
