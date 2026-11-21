import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserPin } from "../shared/local/browser-runtime.ts";
import { BROWSER_PIN, ChromeInstallError, createBrowserHost } from "./browser-host.ts";

const work = mkdtempSync(join(tmpdir(), "subkit-bh-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ZIP = new TextEncoder().encode("pretend zip");
const EXECUTABLE = "chrome-mac-arm64/Chrome.app/Contents/MacOS/Chrome";

function pinFor(bytes: Uint8Array): BrowserPin {
  return {
    ...BROWSER_PIN,
    chrome_for_testing: {
      ...BROWSER_PIN.chrome_for_testing,
      targets: {
        "darwin-arm64": {
          asset: "mac-arm64/chrome-mac-arm64.zip",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          executable: EXECUTABLE,
        },
      },
    },
  };
}

function host(name: string, body: Uint8Array, extra: { platform?: string } = {}) {
  const dataDir = join(work, name);
  const cliPath = join(work, name, "agent-browser");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(cliPath, "#!/bin/sh\n");
  const requested: string[] = [];
  const unzipped: string[] = [];
  const browser = createBrowserHost({
    dataDir,
    tmpDir: work,
    cliPath,
    platform: extra.platform ?? "darwin",
    arch: "arm64",
    pin: pinFor(ZIP),
    fetch: (async (url: string) => {
      requested.push(String(url));
      return new Response(Buffer.from(body));
    }) as typeof fetch,
    unzip: (zip, into) => {
      unzipped.push(readFileSync(zip, "utf8"));
      const executable = join(into, EXECUTABLE);
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "");
    },
    teardown: {
      readText: async () => null,
      processes: async () => [],
      kill: () => {},
      remove: async () => {},
    },
  });
  return { browser, dataDir, requested, unzipped };
}

describe("browser host", () => {
  test("installs the pinned Chrome for Testing once into the data folder", async () => {
    const { browser, dataDir, requested, unzipped } = host("ok", ZIP);
    expect(browser.state()).toBe("missing");
    expect(browser.runtime()).toBeNull();
    const runtime = await browser.installChrome(new AbortController().signal);
    expect(requested).toEqual([
      "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
    ]);
    expect(unzipped).toEqual(["pretend zip"]);
    expect(browser.state()).toBe("ready");
    expect(runtime.version).toBe("0.43.0");
    expect(runtime.layout.chrome_executable).toBe(
      join(dataDir, "browser/chrome-158.0.8127.36", EXECUTABLE),
    );
    expect(existsSync(join(dataDir, "browser/chrome-download.zip"))).toBe(false);
    expect(statSync(join(dataDir, "browser/profiles")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dataDir, "browser/agent-browser.json"), "utf8")).toBe("{}");
    await browser.installChrome(new AbortController().signal);
    expect(requested).toHaveLength(1);
  });

  test("a download that does not match the pin is discarded", async () => {
    const { browser, dataDir, unzipped } = host("bad", new TextEncoder().encode("tampered zip"));
    await expect(browser.installChrome(new AbortController().signal)).rejects.toBeInstanceOf(
      ChromeInstallError,
    );
    expect(unzipped).toEqual([]);
    expect(existsSync(join(dataDir, "browser/chrome-download.zip"))).toBe(false);
    expect(existsSync(join(dataDir, "browser/chrome-158.0.8127.36"))).toBe(false);
    expect(browser.state()).toBe("missing");
  });

  test("other systems have no browser capability", async () => {
    const { browser } = host("win", ZIP, { platform: "win32" });
    expect(browser.state()).toBe("unsupported");
    expect(await browser.killAll()).toEqual([]);
    await expect(browser.installChrome(new AbortController().signal)).rejects.toBeInstanceOf(
      ChromeInstallError,
    );
  });

  test("killAll sweeps every partition profile", async () => {
    const { browser, dataDir } = host("sweep", ZIP);
    mkdirSync(join(dataDir, "browser/profiles/p1"), { recursive: true });
    expect(await browser.killAll()).toEqual([]);
  });
});
