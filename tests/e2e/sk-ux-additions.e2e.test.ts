// Offline smoke tier for the three sk UX additions:
//   - `sk workflows invoke-snippet <id> [--lang ...] [--json]`
//   - `sk review [--json]`
//   - bare-`sk` no-profile non-TTY contract (unchanged: stderr + exit 2)
//
// All assertions are offline: invoke-snippet only formats a snippet,
// review degrades to an empty digest when the engine is unreachable,
// and the non-TTY no-profile path never touches the network. Tests are
// skipped when dist/sk doesn't exist (CI builds it first).

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BINARY = resolve(REPO_ROOT, "dist", "sk");

function withProfileHome(): string {
  // A throwaway $HOME with a saved api-key profile pointed at an
  // unreachable engine, so commands resolve a profile but never make a
  // successful network call.
  const home = mkdtempSync(path.join(tmpdir(), "sk-ux-"));
  spawnSync(
    BINARY,
    ["login", "--api-key", "wf_live_smoke", "--engine-url", "https://engine.example.com"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        NO_COLOR: "1",
        NO_UPDATE_CHECK: "1",
      },
    },
  );
  return home;
}

function run(args: string[], home: string): SpawnSyncReturns<string> {
  return spawnSync(BINARY, args, {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1", NO_UPDATE_CHECK: "1" },
    timeout: 10_000,
  });
}

const skip = !existsSync(BINARY);

describe("sk UX additions smoke", () => {
  test.skipIf(skip)("`sk workflows invoke-snippet` emits a curl snippet by default", () => {
    const home = withProfileHome();
    try {
      const r = run(["workflows", "invoke-snippet", "wf_abc123"], home);
      expect(r.status).toBe(0);
      const out = r.stdout ?? "";
      expect(out).toContain("Run this workflow from your app:");
      expect(out).toContain("curl -sS -X POST");
      expect(out).toContain("https://engine.example.com/v1/executions");
      expect(out).toContain("wf_abc123");
      // The real key is NEVER printed — only the env placeholder.
      expect(out).toContain("$SK_API_KEY");
      expect(out).not.toContain("wf_live_smoke");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(skip)("`sk workflows invoke-snippet --lang node` emits a fetch snippet", () => {
    const home = withProfileHome();
    try {
      const r = run(["workflows", "invoke-snippet", "wf_abc123", "--lang", "node"], home);
      expect(r.status).toBe(0);
      const out = r.stdout ?? "";
      expect(out).toContain("await fetch(");
      expect(out).toContain("process.env.SK_API_KEY");
      expect(out).not.toContain("wf_live_smoke");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(skip)("`sk workflows invoke-snippet --lang python` emits a requests snippet", () => {
    const home = withProfileHome();
    try {
      const r = run(["workflows", "invoke-snippet", "wf_abc123", "--lang", "python"], home);
      expect(r.status).toBe(0);
      const out = r.stdout ?? "";
      expect(out).toContain("import requests");
      expect(out).toContain("requests.post(");
      expect(out).toContain("os.environ['SK_API_KEY']");
      expect(out).not.toContain("wf_live_smoke");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(skip)(
    "`sk workflows invoke-snippet --json` is parseable and omits the real key",
    () => {
      const home = withProfileHome();
      try {
        const r = run(["workflows", "invoke-snippet", "wf_abc123", "--json"], home);
        expect(r.status).toBe(0);
        const parsed = JSON.parse(r.stdout as string) as {
          route: string;
          workflow_id: string;
          snippet: string;
        };
        expect(parsed.route).toBe("POST /v1/executions");
        expect(parsed.workflow_id).toBe("wf_abc123");
        expect(parsed.snippet).toContain("$SK_API_KEY");
        expect(JSON.stringify(parsed)).not.toContain("wf_live_smoke");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(skip)("`sk review --json` returns the three-section digest shape", () => {
    const home = withProfileHome();
    try {
      const r = run(["review", "--json"], home);
      // Engine unreachable → each section degrades to an empty list plus
      // a note; the command still exits 0 with a well-formed envelope.
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout as string) as {
        patch_candidates: unknown[];
        skill_candidates: unknown[];
        failed_executions: unknown[];
        total: number;
      };
      expect(Array.isArray(parsed.patch_candidates)).toBe(true);
      expect(Array.isArray(parsed.skill_candidates)).toBe(true);
      expect(Array.isArray(parsed.failed_executions)).toBe(true);
      expect(typeof parsed.total).toBe("number");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(skip)("bare `sk` with no profile on non-TTY keeps the exit-2 contract", () => {
    const home = mkdtempSync(path.join(tmpdir(), "sk-ux-noauth-"));
    try {
      // Empty stdin → non-TTY; no profile saved → must print the
      // one-liner and exit 2 (scripts/CI contract), NOT open the picker.
      const r = spawnSync(BINARY, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: home,
          NO_COLOR: "1",
          NO_UPDATE_CHECK: "1",
        },
        input: "",
        timeout: 5_000,
      });
      expect(r.status).toBe(2);
      expect(`${r.stderr ?? ""}`).toContain("not logged in");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
