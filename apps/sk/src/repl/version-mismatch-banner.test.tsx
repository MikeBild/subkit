// CLI ↔ engine version-skew classifier. Without it the operator has to
// know that the engine container is running stale code by guessing
// from missing fixes (source has the fix, container does not). The CLI
// surfaces a one-line banner when versions diverge so the rebuild hint
// is visible from the welcome row.

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { classifyVersionSkew, VersionMismatchBanner } from "./version-mismatch-banner.tsx";

describe("classifyVersionSkew", () => {
  test("identical versions → match", () => {
    expect(classifyVersionSkew("3.2.0", "3.2.0").severity).toBe("match");
  });

  test("CLI is newer → engine_older (the dominant stale-container case)", () => {
    expect(classifyVersionSkew("3.2.1", "3.2.0").severity).toBe("engine_older");
    expect(classifyVersionSkew("3.3.0", "3.2.0").severity).toBe("engine_older");
    expect(classifyVersionSkew("4.0.0", "3.2.0").severity).toBe("engine_older");
  });

  test("CLI is older → cli_older", () => {
    expect(classifyVersionSkew("3.1.0", "3.2.0").severity).toBe("cli_older");
    expect(classifyVersionSkew("3.2.0", "3.2.1").severity).toBe("cli_older");
  });

  test("dev CLI build → dev_build (skew is intentional)", () => {
    expect(classifyVersionSkew("0.0.0-dev", "3.2.0").severity).toBe("dev_build");
    expect(classifyVersionSkew("dev", "3.2.0").severity).toBe("dev_build");
    expect(classifyVersionSkew("3.2.0-dev", "3.2.0").severity).toBe("dev_build");
  });

  test("trims whitespace before comparing", () => {
    expect(classifyVersionSkew(" 3.2.0 ", "3.2.0\n").severity).toBe("match");
  });

  test("handles extra suffix segments without throwing", () => {
    expect(classifyVersionSkew("3.2.0-rc.1", "3.2.0-rc.2").severity).toBe("cli_older");
  });
});

describe("VersionMismatchBanner", () => {
  test("renders engine_older message with the restart hint", () => {
    const { lastFrame } = render(
      <VersionMismatchBanner
        snapshot={{ cliVersion: "3.2.1", engineVersion: "3.2.0", severity: "engine_older" }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("engine is older");
    expect(frame).toContain("3.2.1");
    expect(frame).toContain("3.2.0");
    expect(frame).toContain("bun run dev");
  });

  test("renders cli_older message with the upgrade hint", () => {
    const { lastFrame } = render(
      <VersionMismatchBanner
        snapshot={{ cliVersion: "3.2.0", engineVersion: "3.2.1", severity: "cli_older" }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("CLI is older");
    expect(frame).toContain("upgrade sk");
  });

  test("renders nothing when versions match", () => {
    const { lastFrame } = render(
      <VersionMismatchBanner
        snapshot={{ cliVersion: "3.2.0", engineVersion: "3.2.0", severity: "match" }}
      />,
    );
    expect(lastFrame() ?? "").toBe("");
  });

  test("renders nothing for dev builds", () => {
    const { lastFrame } = render(
      <VersionMismatchBanner
        snapshot={{ cliVersion: "0.0.0-dev", engineVersion: "3.2.0", severity: "dev_build" }}
      />,
    );
    expect(lastFrame() ?? "").toBe("");
  });
});
