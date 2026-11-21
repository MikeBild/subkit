import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ORIGIN,
  APP_SCHEME,
  CONNECT_CSP,
  CONNECT_URL,
  isConnectUrl,
  parseAppUrl,
} from "./app-url.ts";
import { CHANNELS } from "./channel.ts";

const page = readFileSync(join(import.meta.dir, "..", "connect", "index.html"), "utf8");
const styles = readFileSync(join(import.meta.dir, "..", "connect", "styles.css"), "utf8");

describe("app url", () => {
  test("the page scheme is not a link scheme of any channel", () => {
    expect(CONNECT_URL).toBe("subkit-app://shell/index.html");
    for (const channel of Object.values(CHANNELS)) expect(channel.scheme).not.toBe(APP_SCHEME);
  });

  test("only the app origin without port or credentials is an app url", () => {
    expect(parseAppUrl("subkit-app://shell/connect.css")?.pathname).toBe("/connect.css");
    for (const raw of [
      "subkit-app://other/index.html",
      "subkit-app://shell:8080/index.html",
      "subkit-app://user@shell/index.html",
      "subkit-app://shell.example.com/index.html",
      "subkit://shell/index.html",
      "https://shell/index.html",
      "file:///Applications/SubKit.app/Contents/Resources/app.asar/dist/connect/index.html",
      "not a url",
      "",
    ])
      expect(parseAppUrl(raw)).toBeNull();
  });

  test("the connect page is recognized with a query or a fragment and nothing else is", () => {
    expect(isConnectUrl(CONNECT_URL)).toBe(true);
    expect(isConnectUrl(`${CONNECT_URL}?view=settings#top`)).toBe(true);
    expect(isConnectUrl("subkit-app://shell/")).toBe(false);
    expect(isConnectUrl("subkit-app://shell/connect.js")).toBe(false);
    expect(isConnectUrl("subkit-app://shell/index.html/extra")).toBe(false);
    expect(isConnectUrl("subkit-app://evil/index.html")).toBe(false);
    expect(isConnectUrl("file:///tmp/index.html")).toBe(false);
    expect(isConnectUrl("https://subkit.example.com/index.html")).toBe(false);
  });
});

describe("connect page policy", () => {
  test("the policy of the page is the policy the shell sends", () => {
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page);
    expect(meta?.[1]).toBe(CONNECT_CSP);
  });

  test("the policy names the app origin and nothing remote", () => {
    const directives = new Map(
      CONNECT_CSP.split("; ").map((directive) => {
        const [name = "", ...sources] = directive.split(" ");
        return [name, sources] as const;
      }),
    );
    expect(directives.get("default-src")).toEqual(["'none'"]);
    for (const name of ["script-src", "style-src", "font-src", "img-src"])
      expect(directives.get(name)).toEqual([APP_ORIGIN]);
    expect(CONNECT_CSP).not.toMatch(/https?:|file:|data:|blob:|\*|unsafe|'self'/);
  });

  test("the page and its stylesheet load only relative files", () => {
    const references = [
      ...[...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? ""),
      ...[...styles.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? ""),
    ];
    expect(references.length).toBeGreaterThan(3);
    for (const reference of references) expect(reference).toMatch(/^[a-z][a-z0-9./-]*$/);
    for (const reference of references) expect(reference).not.toContain("..");
  });
});
