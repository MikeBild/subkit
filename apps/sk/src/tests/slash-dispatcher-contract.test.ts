import { describe, expect, test } from "bun:test";
import { classifySlash, UNSUPPORTED_SLASH_GUIDANCE } from "../repl/slash/dispatcher.ts";
import { SLASH_COMMANDS } from "../slash.ts";

describe("slash dispatcher contract", () => {
  test("every registered command resolves to a routing other than unknown", () => {
    for (const cmd of SLASH_COMMANDS) {
      const plan = classifySlash(cmd.name);
      expect(
        plan.routing,
        `slash /${cmd.name} resolves to unknown — registry/dispatcher drift`,
      ).not.toBe("unknown");
    }
  });

  test("aliases also resolve to a routing other than unknown", () => {
    for (const cmd of SLASH_COMMANDS) {
      for (const alias of cmd.aliases ?? []) {
        const plan = classifySlash(alias);
        expect(plan.routing, `alias /${alias} (of /${cmd.name}) resolves to unknown`).not.toBe(
          "unknown",
        );
      }
    }
  });

  test("every unsupported-slash guidance entry is NOT a registered command", () => {
    const registered = new Set<string>();
    for (const cmd of SLASH_COMMANDS) {
      registered.add(cmd.name);
      for (const alias of cmd.aliases ?? []) registered.add(alias);
    }
    const overlap: string[] = [];
    for (const name of Object.keys(UNSUPPORTED_SLASH_GUIDANCE)) {
      if (registered.has(name)) overlap.push(name);
    }
    expect(
      overlap,
      `${overlap.length} guidance entries shadow registered commands: ${overlap.join(", ")}`,
    ).toEqual([]);
  });

  test("unsupported slashes route through the unknown branch and emit guidance", () => {
    for (const name of Object.keys(UNSUPPORTED_SLASH_GUIDANCE)) {
      const plan = classifySlash(name);
      expect(plan.routing, `unsupported slash /${name} should be unknown`).toBe("unknown");
    }
  });

  test("the install-* per-service slashes are gone without guidance", () => {
    for (const name of [
      "install-slack",
      "install-teams",
      "install-github",
      "install-google-workspace",
      "install-salesforce",
      "install-jira",
      "install-hubspot",
    ]) {
      expect(classifySlash(name).routing).toBe("unknown");
      expect(UNSUPPORTED_SLASH_GUIDANCE[name]).toBeUndefined();
    }
  });

  test("the unified `/install` slash is registered and opens the onboarding wizard", () => {
    const plan = classifySlash("install");
    expect(plan.routing).not.toBe("unknown");
    expect(plan.command?.name).toBe("onboard");
    expect(plan.command?.aliases ?? []).toContain("install");
    expect(plan.command?.help).toMatch(/onboarding wizard/i);
    expect(plan.command?.help).toMatch(/template/i);
  });
});
