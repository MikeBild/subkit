import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { VersionMismatchBanner } from "./version-mismatch-banner.tsx";

function frame(cliVersion: string, engineVersion: string): string {
  const { lastFrame } = render(
    <VersionMismatchBanner cliVersion={cliVersion} engineVersion={engineVersion} />,
  );
  return lastFrame() ?? "";
}

describe("VersionMismatchBanner", () => {
  test("an older CLI is told how to match the engine", () => {
    const text = frame("3.1.0", "3.2.0");
    expect(text).toContain("older than the engine");
    expect(text).toContain("update --match-engine");
  });

  test("a newer CLI names both ways out", () => {
    expect(frame("3.3.0", "3.2.0")).toContain("newer than the engine");
  });

  test("renders nothing for patch drift, a match or a dev build", () => {
    expect(frame("3.2.1", "3.2.0")).toBe("");
    expect(frame("3.2.0", "3.2.0")).toBe("");
    expect(frame("0.0.0-dev", "3.2.0")).toBe("");
  });
});
