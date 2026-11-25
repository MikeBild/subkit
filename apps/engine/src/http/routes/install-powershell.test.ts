import { describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../openapi.ts";
import { _internal, pinPowerShellScript, registerInstallRoute } from "./install.ts";

const pins = { version: "13.1.0", engineUrl: "https://engine.example.com", downloadUrl: null };
const DEFAULT_LINE = /^if \(-not \$Subkit[A-Za-z]+\) \{ \$Subkit[A-Za-z]+ = /;

const defaultsOf = (script: string): string[] =>
  script.split("\n").filter((line) => DEFAULT_LINE.test(line));

describe("pinned PowerShell installer", () => {
  test("changes only its default lines", () => {
    const pinned = pinPowerShellScript(_internal.powershellScript, pins);
    const strip = (script: string) =>
      script
        .split("\n")
        .filter((line) => !DEFAULT_LINE.test(line))
        .join("\n");
    expect(strip(pinned)).toBe(strip(_internal.powershellScript));
  });

  test("pins the engine version and address and keeps the variables overridable", () => {
    expect(defaultsOf(pinPowerShellScript(_internal.powershellScript, pins))).toEqual([
      'if (-not $SubkitVersion) { $SubkitVersion = "13.1.0" }',
      'if (-not $SubkitDownloadUrl) { $SubkitDownloadUrl = "" }',
      'if (-not $SubkitEngineUrl) { $SubkitEngineUrl = "https://engine.example.com" }',
      'if (-not $SubkitInstallDir) { $SubkitInstallDir = Join-Path $env:LOCALAPPDATA "Programs\\subkit" }',
      'if (-not $SubkitReleasesUrl) { $SubkitReleasesUrl = "https://github.com/MikeBild/subkit/releases" }',
    ]);
  });

  test("downloads from the engine when it bundles the CLI", () => {
    expect(
      pinPowerShellScript(_internal.powershellScript, {
        ...pins,
        downloadUrl: "https://engine.example.com/install",
      }),
    ).toContain('$SubkitDownloadUrl = "https://engine.example.com/install" }');
  });

  test("strips characters that could break out of the PowerShell string", () => {
    const pinned = pinPowerShellScript(_internal.powershellScript, {
      ...pins,
      engineUrl: 'https://x.example"; Remove-Item $HOME `',
    });
    expect(pinned).toContain('$SubkitEngineUrl = "https://x.example; Remove-Item HOME " }');
  });

  test("refuses admin shells and checks every checksum", () => {
    expect(_internal.powershellScript).toContain("not from an administrator shell");
    expect(_internal.powershellScript).toContain("Get-FileHash -Algorithm SHA256");
  });

  test("is served at /install.ps1 as text", async () => {
    const app = new OpenAPIHono<AppEnv>();
    registerInstallRoute(app);
    const response = await app.request("http://127.0.0.1/install.ps1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain('$SubkitEngineUrl = "http://127.0.0.1" }');
  });
});
