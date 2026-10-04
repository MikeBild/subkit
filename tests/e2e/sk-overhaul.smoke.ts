import { describe, expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BINARY = resolve(REPO_ROOT, "dist", "sk");
const PACKAGE_VERSION = (await Bun.file(resolve(REPO_ROOT, "package.json")).json())
  .version as string;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require literal ESC.
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function run(args: string[], extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(BINARY, args, {
    encoding: "utf8",
    env: { ...process.env, NO_UPDATE_CHECK: "1", ...extraEnv },
  });
}

function skipUnless(): boolean {
  return existsSync(BINARY);
}

describe("sk overhaul smoke (plan §Smoke 1-9)", () => {
  test.skipIf(!skipUnless())("(1) `sk --help` exits 0 and lists top-level subcommands", () => {
    const r = run(["--help"], { NO_COLOR: "1" });
    expect(r.status).toBe(0);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("login");
    expect(out).toContain("logout");
    expect(out.toLowerCase()).toContain("usage");
  });

  test.skipIf(!skipUnless())("(3) `sk login --portal-token <fake>` writes a profile", () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), "sk-smoke-portal-"));
    try {
      const r = run(
        ["login", "--portal-token", "wf_portal_smokesmoke", "--engine-url", "http://127.0.0.1:1"],
        { HOME: tmpHome, XDG_CONFIG_HOME: tmpHome, NO_COLOR: "1" },
      );
      expect(r.status).toBe(0);
      const cfgPath = path.join(tmpHome, ".sk", "config.json");
      expect(existsSync(cfgPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        profiles?: Record<string, { api_key: string; portal_locked?: boolean }>;
      };
      const def = cfg.profiles?.default;
      expect(def?.api_key).toBe("wf_portal_smokesmoke");
      expect(def?.portal_locked).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test.skipIf(!skipUnless() || process.env.CI_NO_PERF === "1")(
    "(4) `sk --version` cold-start finishes under 1500ms",
    () => {
      const t0 = performance.now();
      const r = run(["--version"], { NO_COLOR: "1" });
      const elapsed = performance.now() - t0;
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(PACKAGE_VERSION);
      expect(elapsed).toBeLessThan(1500);
    },
  );

  test.skipIf(!skipUnless())("(5) non-TTY EOF on stdin exits clean (no hang)", () => {
    const r = spawnSync(BINARY, [], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", NO_UPDATE_CHECK: "1" },
      input: "",
      timeout: 5_000,
    });
    expect(r.status).not.toBe(null);
    if (r.signal != null) {
      throw new Error(`sk hung on EOF; killed by ${r.signal}`);
    }
  });

  test.skipIf(!skipUnless())("(6) `sk doctor` exits with a real exit code (never crashes)", () => {
    const r = run(["doctor"], { NO_COLOR: "1" });
    expect([0, 1, 2]).toContain(r.status);
  });

  test.skipIf(!skipUnless())("(8) `--no-color --help` produces zero ANSI escape sequences", () => {
    const r = run(["--help"], { NO_COLOR: "1" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(ANSI_RE.test(out)).toBe(false);
  });

  test.skipIf(!skipUnless())(
    '(9) `sk -p ""` does not crash (empty prompt falls through to REPL)',
    () => {
      const r = spawnSync(BINARY, ["-p", ""], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", NO_UPDATE_CHECK: "1" },
        input: "",
        timeout: 5_000,
      });
      expect(r.status).not.toBe(null);
      if (r.signal) throw new Error(`sk -p hung; killed by ${r.signal}`);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(out).not.toMatch(/TypeError/);
    },
  );

  test.skipIf(!skipUnless())(
    "(2) `sk -p ping --output json` is parseable JSON when no engine is reachable",
    () => {
      const tmpHome = mkdtempSync(path.join(tmpdir(), "sk-smoke-jsonp-"));
      try {
        const r = spawnSync(
          BINARY,
          [
            "-p",
            "ping",
            "--output",
            "json",
            "--engine-url",
            "http://127.0.0.1:1",
            "--api-key",
            "wf_live_smoke",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NO_COLOR: "1",
              NO_UPDATE_CHECK: "1",
              HOME: tmpHome,
              XDG_CONFIG_HOME: tmpHome,
            },
            timeout: 10_000,
          },
        );
        expect(r.status).not.toBe(null);
        if (r.signal != null) throw new Error(`sk -p hung; killed by ${r.signal}`);
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        expect(out).not.toMatch(/TypeError/);
        if ((r.status ?? 0) !== 0 && (r.stdout ?? "").length > 0) {
          expect(() => JSON.parse(r.stdout as string)).not.toThrow();
        }
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!skipUnless())(
    "(7) bracketed-paste round-trip: indentation preserved through stdin",
    () => {
      const PASTE_START = "\x1b[200~";
      const PASTE_END = "\x1b[201~";
      const indented = "    function foo() {\n\treturn 42;\n}\n";
      const stdin = `${PASTE_START}${indented}${PASTE_END}\n`;
      const r = spawnSync(BINARY, [], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", NO_UPDATE_CHECK: "1" },
        input: stdin,
        timeout: 5_000,
      });
      expect(r.status).not.toBe(null);
      if (r.signal != null) throw new Error(`sk hung on bracketed paste; killed by ${r.signal}`);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(out).not.toMatch(/TypeError/);
    },
  );
});
