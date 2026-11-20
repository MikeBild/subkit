import { describe, expect, test } from "bun:test";
import {
  cockpitBuildId,
  cockpitInstallationWorkerScript,
  cockpitShellUrls,
  joinWorkerSources,
} from "./cockpit-worker.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const sources = [bytes("const core = 1;\n\n"), bytes("const worker = 2;\n")];

function script(shell: string, assetPaths: string[], parts = sources): string {
  return cockpitInstallationWorkerScript({ shell: bytes(shell), assetPaths, sources: parts });
}

function build(source: string): string {
  return /^self\.COCKPIT_BUILD = "([0-9a-f]{16})";$/m.exec(source)?.[1] ?? "";
}

describe("cockpit build identity", () => {
  test("is stable for the same parts and differs when any part differs", () => {
    expect(cockpitBuildId(["a", "b"])).toBe(cockpitBuildId(["a", "b"]));
    expect(cockpitBuildId(["a", "b"])).toMatch(/^[0-9a-f]{16}$/);
    expect(cockpitBuildId(["a", "b"])).not.toBe(cockpitBuildId(["a", "c"]));
    expect(cockpitBuildId(["ab", ""])).not.toBe(cockpitBuildId(["a", "b"]));
    expect(cockpitBuildId([bytes("a")])).toBe(cockpitBuildId(["a"]));
  });
});

describe("files the installed app keeps", () => {
  test("are the hashed bundle files under the Cockpit path, sorted and unique", () => {
    expect(
      cockpitShellUrls(["assets/index-b.js", "assets/index-a.css", "assets/index-b.js"]),
    ).toEqual(["/cockpit/assets/index-a.css", "/cockpit/assets/index-b.js"]);
  });

  test("never the page, tenant files or anything outside the bundle directory", () => {
    expect(
      cockpitShellUrls([
        "index.html",
        "favicon.svg",
        "installation-worker.js",
        "assets/../index.html",
        "assets/nested/file.js",
        "/assets/index.js",
        "assets/",
      ]),
    ).toEqual([]);
  });
});

describe("installation worker script", () => {
  test("carries the build and the files in front of the joined sources", () => {
    const source = script("<html>one</html>", ["assets/index-a.js"]);
    expect(source.split("\n")).toEqual([
      `self.COCKPIT_BUILD = "${build(source)}";`,
      'self.COCKPIT_SHELL = ["/cockpit/assets/index-a.js"];',
      "const core = 1;",
      "const worker = 2;",
      "",
    ]);
    expect(build(source)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is byte-identical for the same build, so the browser sees no update", () => {
    expect(script("<html>one</html>", ["assets/index-a.js"])).toBe(
      script("<html>one</html>", ["assets/index-a.js"]),
    );
  });

  test("changes with the page, the bundle files or the worker code", () => {
    const base = build(script("<html>one</html>", ["assets/index-a.js"]));
    expect(build(script("<html>two</html>", ["assets/index-a.js"]))).not.toBe(base);
    expect(build(script("<html>one</html>", ["assets/index-b.js"]))).not.toBe(base);
    expect(
      build(script("<html>one</html>", ["assets/index-a.js"], [bytes("const core = 3;")])),
    ).not.toBe(base);
  });

  test("joined sources keep each file once and end without trailing blank lines", () => {
    expect(joinWorkerSources(sources)).toBe("const core = 1;\nconst worker = 2;");
  });
});
