import { describe, expect, test } from "bun:test";
import manifest from "../../../vendor/agent-desktop.json";
import {
  AGENT_DESKTOP_FILES,
  agentDesktopNotice,
  helperBinaryPath,
  parseCodesignDetails,
  signingProblem,
  teamOfIdentity,
} from "./agent-desktop-bundle.ts";

const SIGNED = `Executable=/x/agent-desktop
Identifier=agent_desktop-4624558c128ed245
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=8025 flags=0x10000(runtime) hashes=245+2 location=embedded
Signature size=9051
Timestamp=21. Nov 2026 at 10:25:06
TeamIdentifier=2S9ZC5J7X9`;

const UPSTREAM = `CodeDirectory v=20400 size=31448 flags=0x20002(adhoc,linker-signed) hashes=979+0 location=embedded
Signature=adhoc
TeamIdentifier=not set`;

describe("pinned helper", () => {
  test("pins one Apple Silicon archive with both binaries", () => {
    expect(Object.keys(manifest.targets)).toEqual(["darwin-arm64"]);
    expect(manifest.version).toBe("1.3.1");
    expect(manifest.contract).toBe("2.6");
    const target = manifest.targets["darwin-arm64"];
    expect(target.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(target.files).sort()).toEqual([...AGENT_DESKTOP_FILES].sort());
  });
});

describe("codesign details", () => {
  test("reads the hardened runtime flag and the team", () => {
    expect(parseCodesignDetails(SIGNED)).toEqual({
      runtime: true,
      team: "2S9ZC5J7X9",
      adhoc: false,
    });
    expect(parseCodesignDetails(UPSTREAM)).toEqual({ runtime: false, team: null, adhoc: true });
    expect(parseCodesignDetails("")).toEqual({ runtime: false, team: null, adhoc: false });
  });

  test("names what is wrong with a signature", () => {
    expect(signingProblem(parseCodesignDetails(SIGNED), "2S9ZC5J7X9")).toBeNull();
    expect(signingProblem(parseCodesignDetails(UPSTREAM), "2S9ZC5J7X9")).toBe("ad hoc signature");
    expect(signingProblem({ runtime: false, team: "2S9ZC5J7X9", adhoc: false }, "2S9ZC5J7X9")).toBe(
      "hardened runtime missing",
    );
    expect(signingProblem({ runtime: true, team: "AAAAAAAAAA", adhoc: false }, "2S9ZC5J7X9")).toBe(
      "team AAAAAAAAAA instead of 2S9ZC5J7X9",
    );
    expect(signingProblem({ runtime: true, team: null, adhoc: false }, "2S9ZC5J7X9")).toBe(
      "team none instead of 2S9ZC5J7X9",
    );
  });

  test("takes the team from a Developer ID identity", () => {
    expect(teamOfIdentity("Developer ID Application: Mike Bild (2S9ZC5J7X9)")).toBe("2S9ZC5J7X9");
    expect(teamOfIdentity("-")).toBeNull();
  });
});

describe("helperBinaryPath", () => {
  const base = { resourcesPath: "/A/SubKit.app/Contents/Resources", appRoot: "/repo/apps/desktop" };

  test("packaged apps use Contents/Helpers", () => {
    expect(helperBinaryPath({ ...base, packaged: true, platform: "darwin", arch: "arm64" })).toBe(
      "/A/SubKit.app/Contents/Helpers/agent-desktop/agent-desktop",
    );
  });

  test("development uses the fetched folder", () => {
    expect(helperBinaryPath({ ...base, packaged: false, platform: "darwin", arch: "arm64" })).toBe(
      "/repo/apps/desktop/resources/agent-desktop/darwin-arm64/agent-desktop",
    );
  });

  test("only Apple Silicon Macs get computer use", () => {
    expect(
      helperBinaryPath({ ...base, packaged: true, platform: "darwin", arch: "x64" }),
    ).toBeNull();
    expect(
      helperBinaryPath({ ...base, packaged: true, platform: "win32", arch: "arm64" }),
    ).toBeNull();
  });
});

describe("agentDesktopNotice", () => {
  test("names the version, source and unchanged binaries before the license", () => {
    const notice = agentDesktopNotice("1.3.1", "https://example.test/x", "LICENSE TEXT\n\n");
    expect(notice).toContain("agent-desktop 1.3.1 (Apache-2.0)");
    expect(notice).toContain("https://example.test/x");
    expect(notice).toContain("ship unchanged");
    expect(notice.endsWith("LICENSE TEXT\n")).toBe(true);
  });
});

describe("strict matching", () => {
  test("the team line must stand alone and be exactly ten characters", () => {
    expect(parseCodesignDetails("XTeamIdentifier=2S9ZC5J7X9").team).toBeNull();
    expect(parseCodesignDetails("TeamIdentifier=2S9ZC5J7X9X").team).toBeNull();
    expect(parseCodesignDetails("a\nTeamIdentifier=2S9ZC5J7X9\nb").team).toBe("2S9ZC5J7X9");
  });

  test("the identity team sits at the end, trailing spaces allowed", () => {
    expect(teamOfIdentity("Developer ID Application: X (2S9ZC5J7X9) extra")).toBeNull();
    expect(teamOfIdentity("Developer ID Application: X (2S9ZC5J7X9)  ")).toBe("2S9ZC5J7X9");
  });

  test("the notice has a fixed layout", () => {
    expect(agentDesktopNotice("1.3.1", "https://s", "L\n")).toBe(
      [
        "",
        "================================================================================",
        "agent-desktop 1.3.1 (Apache-2.0)",
        "https://s",
        "The agent-desktop and agent-desktop-macos-helper binaries ship unchanged; SubKit only re-signs them.",
        "--------------------------------------------------------------------------------",
        "L",
        "",
      ].join("\n"),
    );
  });
});
