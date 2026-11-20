import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { contentTypeFor, isInside, resolveAppFile } from "./app-files.ts";

const root = "/opt/SubKit/resources/app.asar/dist/connect";
const get = (url: string) => resolveAppFile("GET", url, root);
const refused = { ok: false, status: 404 } as const;

describe("resolveAppFile", () => {
  test("serves the files of the connect screen with their content type", () => {
    expect(get("subkit-app://shell/index.html")).toEqual({
      ok: true,
      path: join(root, "index.html"),
      contentType: "text/html; charset=utf-8",
    });
    expect(get("subkit-app://shell/connect.js")).toEqual({
      ok: true,
      path: join(root, "connect.js"),
      contentType: "text/javascript; charset=utf-8",
    });
    expect(get("subkit-app://shell/connect.css?v=1#x")).toEqual({
      ok: true,
      path: join(root, "connect.css"),
      contentType: "text/css; charset=utf-8",
    });
    expect(get("subkit-app://shell/fonts/inter-latin-wght-normal.woff2")).toEqual({
      ok: true,
      path: join(root, "fonts", "inter-latin-wght-normal.woff2"),
      contentType: "font/woff2",
    });
    expect(get("subkit-app://shell/icon.png")).toEqual({
      ok: true,
      path: join(root, "icon.png"),
      contentType: "image/png",
    });
  });

  test("answers only GET", () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "get", ""])
      expect(resolveAppFile(method, "subkit-app://shell/index.html", root)).toEqual({
        ok: false,
        status: 405,
      });
  });

  test("refuses every way out of the directory", () => {
    for (const url of [
      "subkit-app://shell/../../package.json",
      "subkit-app://shell/%2e%2e/%2e%2e/package.json",
      "subkit-app://shell/..%2f..%2fpackage.json",
      "subkit-app://shell/..%2findex.html",
      "subkit-app://shell/%2e%2e%2findex.html",
      "subkit-app://shell/%2E%2E%2Fassets%2Ficon.png",
      "subkit-app://shell/..%5cindex.html",
      "subkit-app://shell/fonts%2f..%2f..%2findex.html",
      "subkit-app://shell/fonts/..%2f..%2f..%2findex.html",
      "subkit-app://shell/%252e%252e%252findex.html",
      "subkit-app://shell//etc/passwd.html",
      "subkit-app://shell/%2fetc%2fpasswd.html",
      "subkit-app://shell/C:%5cWindows%5cwin.html",
      "subkit-app://shell/index.html%00.png",
      "subkit-app://shell/%E0%A4%A.html",
      "subkit-app://shell/.hidden.html",
      "subkit-app://shell/fonts/.hidden.css",
    ])
      expect(get(url)).toEqual(refused);
  });

  test("a path the url parser already collapsed never leaves the directory", () => {
    for (const url of [
      "subkit-app://shell/../../index.html",
      "subkit-app://shell/fonts/../../../index.html",
      "subkit-app://shell/%2e%2e/%2e%2e/index.html",
      "subkit-app://shell/./index.html",
    ]) {
      const file = get(url);
      expect(file.ok && isInside(root, file.path)).toBe(true);
    }
  });

  test("lists no directory and guesses no index", () => {
    for (const url of [
      "subkit-app://shell",
      "subkit-app://shell/",
      "subkit-app://shell/fonts",
      "subkit-app://shell/fonts/",
      "subkit-app://shell/index.html/",
    ])
      expect(get(url)).toEqual(refused);
  });

  test("refuses unknown file types and foreign urls", () => {
    for (const url of [
      "subkit-app://shell/package.json",
      "subkit-app://shell/main.cjs",
      "subkit-app://shell/index",
      "subkit-app://shell/connect.js.map",
      "subkit-app://other/index.html",
      "subkit-app://shell:1/index.html",
      "subkit-app://user:secret@shell/index.html",
      "file:///etc/passwd",
      "https://shell/index.html",
      "index.html",
    ])
      expect(get(url)).toEqual(refused);
  });
});

describe("isInside", () => {
  test("accepts only paths below the root", () => {
    expect(isInside(root, join(root, "index.html"))).toBe(true);
    expect(isInside(root, join(root, "fonts", "a.woff2"))).toBe(true);
    expect(isInside(`${root}/`, join(root, "index.html"))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, join(root, ".."))).toBe(false);
    expect(isInside(root, join(root, "..", "main.cjs"))).toBe(false);
    expect(isInside(root, `${root}-other/index.html`)).toBe(false);
    expect(isInside(root, "/etc/passwd")).toBe(false);
    expect(isInside(root, join(root, "..x", "index.html"))).toBe(true);
  });
});

describe("contentTypeFor", () => {
  test("knows the shipped file types regardless of case", () => {
    expect(contentTypeFor("a/b/font.WOFF2")).toBe("font/woff2");
    expect(contentTypeFor("icon.png")).toBe("image/png");
    expect(contentTypeFor("notes.txt")).toBeNull();
    expect(contentTypeFor("Makefile")).toBeNull();
  });
});
