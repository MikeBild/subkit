// Slash-dispatcher contract test.
//
// This is the dispatcher parity gate: every entry in the
// removed-slash guidance map MUST NOT also appear as a registered
// command (otherwise the guidance would shadow a working command),
// and every registered command MUST resolve to a routing other than
// `unknown`.

import { describe, expect, test } from "bun:test";

import { classifySlash, REMOVED_SLASH_GUIDANCE } from "../repl/slash/dispatcher.ts";
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

  test("every removed-slash guidance entry is NOT a registered command", () => {
    const registered = new Set<string>();
    for (const cmd of SLASH_COMMANDS) {
      registered.add(cmd.name);
      for (const alias of cmd.aliases ?? []) registered.add(alias);
    }
    const overlap: string[] = [];
    for (const name of Object.keys(REMOVED_SLASH_GUIDANCE)) {
      if (registered.has(name)) overlap.push(name);
    }
    expect(
      overlap,
      `${overlap.length} guidance entries shadow registered commands: ${overlap.join(", ")}`,
    ).toEqual([]);
  });

  test("removed slashes route through the unknown branch and emit guidance", () => {
    for (const name of Object.keys(REMOVED_SLASH_GUIDANCE)) {
      const plan = classifySlash(name);
      expect(plan.routing, `removed slash /${name} should be unknown`).toBe("unknown");
    }
  });

  test("the install-* per-service slashes are gone", () => {
    const removed = [
      "install-slack",
      "install-teams",
      "install-github",
      "install-google-workspace",
      "install-salesforce",
      "install-jira",
      "install-hubspot",
    ];
    for (const name of removed) {
      const plan = classifySlash(name);
      expect(plan.routing).toBe("unknown");
      expect(REMOVED_SLASH_GUIDANCE[name]).toMatch(/`\/install`/);
    }
  });

  test("the unified `/install` slash is registered and opens the onboarding wizard", () => {
    const plan = classifySlash("install");
    expect(plan.routing).not.toBe("unknown");
    // `/install` is an alias of
    // `/onboard` rather than a duplicate registry entry, so the
    // resolved command is `/onboard` and its help text is the
    // single source of truth for the wizard description. The
    // critical contract — that `/install` resolves and dispatches —
    // is unchanged; the alias must show up in `aliases`.
    expect(plan.command?.name).toBe("onboard");
    expect(plan.command?.aliases ?? []).toContain("install");
    expect(plan.command?.help).toMatch(/onboarding wizard/i);
    expect(plan.command?.help).toMatch(/template/i);
  });
});
