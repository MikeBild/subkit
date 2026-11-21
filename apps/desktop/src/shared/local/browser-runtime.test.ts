import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pinJson from "../../../vendor/agent-browser.json";
import {
  AGENT_BROWSER_CONFIG_FILE,
  agentBrowserDownload,
  agentBrowserEnv,
  agentBrowserNotice,
  BrowserPinSchema,
  browserCliPath,
  browserLayout,
  browserProcesses,
  browserTargetFor,
  CHROME_ARGS,
  chromeDownload,
  licenseMismatches,
  parsePidFile,
  parseProcessTable,
  profileDir,
  SOCKET_PATH_MAX,
  sessionName,
  socketDir,
} from "./browser-runtime.ts";

const pin = BrowserPinSchema.parse(pinJson);

describe("browser pin", () => {
  test("pins agent-browser and Chrome for Testing by version, size and SHA-256", () => {
    expect(pin.version).toBe("0.43.0");
    expect(pin.license).toBe("Apache-2.0");
    expect(agentBrowserDownload(pin, "darwin-arm64")).toEqual({
      url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.43.0/agent-browser-darwin-arm64",
      bytes: 17755040,
      sha256: "05338a8eeddf0b3f9ebf0c87a6c21aedc10685608c68618e1a8483c43eae9c3f",
    });
    expect(chromeDownload(pin, "darwin-arm64")).toEqual({
      url: "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
      bytes: 200339070,
      sha256: "b86d3b393def1f87d369b022abff0a51acb015d6fcb79ddfd1c379c9d72fbbe2",
    });
  });

  test("only Apple Silicon Macs are a browser target", () => {
    expect(browserTargetFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(browserTargetFor("darwin", "x64")).toBeNull();
    expect(browserTargetFor("win32", "x64")).toBeNull();
    const empty = {
      ...pin,
      targets: {},
      chrome_for_testing: { ...pin.chrome_for_testing, targets: {} },
    };
    expect(() => agentBrowserDownload(empty, "darwin-arm64")).toThrow(
      "no pinned agent-browser for darwin-arm64",
    );
    expect(() => chromeDownload(empty, "darwin-arm64")).toThrow(
      "no pinned Chrome for Testing for darwin-arm64",
    );
    expect(() => browserLayout("/d", empty, "darwin-arm64", "/t")).toThrow();
  });

  test("a pin without checksum or with another licence is rejected", () => {
    expect(BrowserPinSchema.safeParse({ ...pinJson, license: "MIT" }).success).toBe(false);
    const broken = structuredClone(pinJson);
    broken.targets["darwin-arm64"].sha256 = "abc";
    expect(BrowserPinSchema.safeParse(broken).success).toBe(false);
    for (const version of ["v0.43.0", "0.43.0-beta", "0.43"])
      expect(BrowserPinSchema.safeParse({ ...pinJson, version }).success).toBe(false);
    for (const version of ["10.43.0", "0.43.10"])
      expect(BrowserPinSchema.safeParse({ ...pinJson, version }).success).toBe(true);
    const ref = pinJson.license_ref;
    for (const license_ref of ["v0.43.0", `x${ref}`, `${ref}x`])
      expect(BrowserPinSchema.safeParse({ ...pinJson, license_ref }).success).toBe(false);
    expect(BrowserPinSchema.safeParse({ ...pinJson, licenses: [] }).success).toBe(false);
    for (const file of ["../LICENSE", "x/agent-browser.LICENSE", "agent-browser.LICENSE.bak"]) {
      const outside = structuredClone(pinJson);
      outside.licenses[0] = { ...pinJson.licenses[0], file } as never;
      expect(BrowserPinSchema.safeParse(outside).success).toBe(false);
    }
  });
});

describe("agent-browser licenses", () => {
  const texts = Object.fromEntries(
    pin.licenses.map((entry) => [
      entry.file,
      readFileSync(join(import.meta.dir, "../../../vendor", entry.file), "utf8"),
    ]),
  );

  test("the vendored texts match their pins at one upstream commit", () => {
    expect(pin.license_ref).toBe("1cc19526f3641c8543d55aa6700e7c55b37ac356");
    expect(pin.licenses.map((entry) => entry.license)).toEqual([
      "Apache-2.0",
      "MPL-2.0",
      "MIT and others",
    ]);
    expect(licenseMismatches(pin, texts)).toEqual([]);
  });

  test("a missing or changed text is named", () => {
    const changed = { ...texts, "agent-browser.LICENSE": `${texts["agent-browser.LICENSE"]} ` };
    expect(licenseMismatches(pin, changed)).toEqual(["agent-browser.LICENSE"]);
    expect(licenseMismatches(pin, {})).toEqual(pin.licenses.map((entry) => entry.file));
  });

  test("the notice names version, source, commit and each license in order", () => {
    const small = {
      version: "0.43.0",
      source: "https://s",
      license_ref: "r".repeat(40),
      licenses: [
        {
          component: "a",
          license: "Apache-2.0",
          file: "a.LICENSE",
          upstream: "LICENSE",
          source: "https://s/tree/a",
          sha256: "",
        },
        {
          component: "b",
          license: "MPL-2.0",
          file: "b.LICENSE",
          upstream: "x/b.txt",
          source: "https://b/tree/c",
          sha256: "",
        },
      ],
    };
    expect(agentBrowserNotice(small, { "a.LICENSE": "A\n\n", "b.LICENSE": "B" })).toBe(
      [
        "",
        "================================================================================",
        "agent-browser 0.43.0 (Apache-2.0)",
        "https://s",
        `License texts as of https://s/tree/${"r".repeat(40)}`,
        "The agent-browser binary ships unchanged; SubKit only re-signs it. Chrome for Testing is downloaded on first use and is not part of the app.",
        "--------------------------------------------------------------------------------",
        "a (Apache-2.0), LICENSE",
        "Source: https://s/tree/a",
        "--------------------------------------------------------------------------------",
        "A",
        "--------------------------------------------------------------------------------",
        "b (MPL-2.0), x/b.txt",
        "Source: https://b/tree/c",
        "--------------------------------------------------------------------------------",
        "B",
        "",
      ].join("\n"),
    );
    expect(agentBrowserNotice(small, {})).toContain("https://b/tree/c\n" + "-".repeat(80) + "\n\n");
  });
});

describe("browser layout", () => {
  test("everything lives in SubKit's data folder, never the person's profile", () => {
    const layout = browserLayout(
      "/Users/a/Library/Application Support/SubKit",
      pin,
      "darwin-arm64",
      "/t",
    );
    const root = "/Users/a/Library/Application Support/SubKit/browser";
    expect(layout).toEqual({
      root,
      chrome_dir: `${root}/chrome-158.0.8127.36`,
      chrome_executable: `${root}/chrome-158.0.8127.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      profiles: `${root}/profiles`,
      sockets: `${root}/r`,
      downloads: `${root}/downloads`,
      captures: `${root}/captures`,
      config: `${root}/agent-browser.json`,
    });
    expect(profileDir(layout, "task-1")).toBe(`${root}/profiles/task-1`);
    expect(AGENT_BROWSER_CONFIG_FILE).toEqual({});
  });

  test("socket paths stay within the Unix limit", () => {
    const short = "/Users/a/Library/Application Support/SubKit/browser";
    expect(socketDir(short, "/t")).toBe(`${short}/r`);
    const fits = "/".padEnd(SOCKET_PATH_MAX - "/r/subkit-0123456789.sock".length, "x");
    expect(socketDir(fits, "/t")).toBe(`${fits}/r`);
    expect(socketDir(`${fits}x`, "/t")).toBe("/t/subkit-browser");
    expect(sessionName("default")).toMatch(/^subkit-[a-f0-9]{10}$/);
    expect(sessionName("a")).not.toBe(sessionName("b"));
  });
});

describe("agent-browser environment", () => {
  const layout = browserLayout("/data", pin, "darwin-arm64", "/t");

  test("pins every location, the proxy and the Chromium flags", () => {
    const env = agentBrowserEnv({
      layout,
      partition: "p1",
      proxy: "http://subkit:s@127.0.0.1:9",
      path: "/bin",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/data/browser",
      TMPDIR: "/data/browser/tmp",
      AGENT_BROWSER_CONFIG: "/data/browser/agent-browser.json",
      AGENT_BROWSER_SOCKET_DIR: "/data/browser/r",
      AGENT_BROWSER_SESSION: sessionName("p1"),
      AGENT_BROWSER_PROFILE: "/data/browser/profiles/p1",
      AGENT_BROWSER_EXECUTABLE_PATH: layout.chrome_executable,
      AGENT_BROWSER_DOWNLOAD_PATH: "/data/browser/downloads",
      AGENT_BROWSER_SCREENSHOT_DIR: "/data/browser/captures",
      AGENT_BROWSER_PROXY: "http://subkit:s@127.0.0.1:9",
      AGENT_BROWSER_PROXY_BYPASS: "<-loopback>",
      AGENT_BROWSER_ARGS: CHROME_ARGS.join("\n"),
    });
    expect(Object.keys(env).some((name) => name.includes("HEADED"))).toBe(false);
    expect(agentBrowserEnv({ layout, partition: "p1", proxy: "x", path: undefined }).PATH).toBe(
      "/usr/bin:/bin",
    );
  });

  test("Chromium runs without QUIC, leaky WebRTC, permission prompts or crash uploads", () => {
    for (const flag of [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--deny-permission-prompts",
      "--disable-crash-reporter",
    ])
      expect(CHROME_ARGS).toContain(flag);
    expect(CHROME_ARGS.every((flag) => flag.startsWith("--") && !flag.includes("\n"))).toBe(true);
  });
});

describe("process teardown model", () => {
  const profile = "/data/browser/profiles/p1";
  const table = [
    "  10     1 /sbin/launchd",
    ` 200   200 /Apps/agent-browser --daemon`,
    ` 300   200 /chrome/Google Chrome for Testing --user-data-dir=${profile} --remote-debugging-port=0`,
    ` 301   200 /chrome/Helper --type=renderer --user-data-dir=${profile}`,
    ` 400   400 /chrome/Other --user-data-dir=${profile}-old --x`,
    ` 500   500 /runner/SubKit Helper --user-data-dir=${profile}`,
    "garbage line",
  ].join("\n");
  const rows = parseProcessTable(table);

  test("parses ps output", () => {
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({ pid: 200, pgid: 200, command: "/Apps/agent-browser --daemon" });
  });

  test("targets the profile's Chrome tree and the daemon, never the runner itself", () => {
    expect(
      browserProcesses(rows, { profile, daemon: 200, self: 500 }).sort((a, b) => a - b),
    ).toEqual([-200, 200, 300, 301]);
    expect(
      browserProcesses(rows, { profile, daemon: 10, self: 999 }).sort((a, b) => a - b),
    ).toEqual([-500, -200, 300, 301, 500]);
    expect(browserProcesses(rows, { profile, daemon: null, self: 999 })).not.toContain(10);
    const sameGroup = parseProcessTable(` 7 42 /x --user-data-dir=${profile}\n 42 42 /runner`);
    expect(browserProcesses(sameGroup, { profile, daemon: null, self: 42 })).toEqual([7]);
    const lowGroup = parseProcessTable(` 8 1 /x --user-data-dir=${profile}`);
    expect(browserProcesses(lowGroup, { profile, daemon: null, self: 9 })).toEqual([8]);
    expect(browserProcesses(rows, { profile, daemon: 200, self: 200 })).not.toContain(200);
  });

  test("pid files hold one plausible pid", () => {
    expect(parsePidFile(" 4242\n")).toBe(4242);
    expect(parsePidFile("1")).toBeNull();
    expect(parsePidFile("abc")).toBeNull();
    expect(parsePidFile("12 13")).toBeNull();
  });
});

describe("where the bundled agent-browser lives", () => {
  const location = {
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    resourcesPath: "/Applications/SubKit.app/Contents/Resources",
    appRoot: "/repo/apps/desktop",
  };

  test("inside the app's resources when packaged, in the fetched folder while developing", () => {
    expect(browserCliPath(location)).toBe(
      "/Applications/SubKit.app/Contents/Resources/agent-browser/agent-browser",
    );
    expect(browserCliPath({ ...location, packaged: false })).toBe(
      "/repo/apps/desktop/resources/agent-browser/darwin-arm64/agent-browser",
    );
  });

  test("nowhere on a Mac without Apple Silicon", () => {
    expect(browserCliPath({ ...location, arch: "x64" })).toBeNull();
  });
});
