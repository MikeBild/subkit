// Unit tests for apps/sk/src/slash.ts — the slash-command registry
// and persona filter.

import { describe, expect, test } from "bun:test";
import {
  findSlashCommand,
  type PersonaProbe,
  renderHelp,
  SLASH_COMMANDS,
  slashCommandsForPersona,
} from "../slash.ts";

const adminPersona: PersonaProbe = { allows: () => true };

const endUserPersona: PersonaProbe = {
  allows: (p) =>
    new Set([
      "conversation:read",
      "conversation:write",
      "conversation:cancel",
      "conversation:list",
    ]).has(p),
};

const portalPersona: PersonaProbe = {
  allows: (p) => new Set(["conversation:read", "conversation:write", "conversation:cancel"]).has(p),
};

describe("sk slash registry", () => {
  test("every command has a unique name", () => {
    const seen = new Set<string>();
    for (const cmd of SLASH_COMMANDS) {
      expect(seen.has(cmd.name)).toBe(false);
      seen.add(cmd.name);
    }
  });

  test("findSlashCommand resolves names and aliases", () => {
    expect(findSlashCommand("help")?.name).toBe("help");
    expect(findSlashCommand("/help")?.name).toBe("help");
    expect(findSlashCommand("new")?.name).toBe("clear");
    expect(findSlashCommand("quit")?.name).toBe("exit");
    expect(findSlashCommand("nope")).toBeUndefined();
  });

  test("admin persona sees every command", () => {
    const visible = slashCommandsForPersona(adminPersona);
    expect(visible.length).toBe(SLASH_COMMANDS.length);
  });

  test("enduser persona: session-scoped commands visible, admin + mcp + skills + tenant + approve hidden", () => {
    const visible = slashCommandsForPersona(endUserPersona).map((c) => c.name);
    // Chat session controls the enduser can use.
    expect(visible).toContain("clear");
    expect(visible).toContain("resume");
    expect(visible).toContain("help");
    expect(visible).toContain("model");
    expect(visible).toContain("compact");
    expect(visible).toContain("init");
    // Anything requiring perms the enduser lacks.
    expect(visible).not.toContain("audit"); // audit:read
    expect(visible).not.toContain("mcp"); // mcp:read
    expect(visible).not.toContain("skills"); // skill:read
    expect(visible).not.toContain("tenant"); // identity:read
    expect(visible).not.toContain("approve"); // conversation:approve
    expect(visible).not.toContain("reject"); // conversation:approve
  });

  test("portal persona hides /resume (no conversation:list)", () => {
    const visible = slashCommandsForPersona(portalPersona).map((c) => c.name);
    expect(visible).not.toContain("resume");
    expect(visible).toContain("clear");
  });

  test("renderHelp omits commands the persona can't run", () => {
    const help = renderHelp(endUserPersona);
    expect(help).toContain("/clear");
    expect(help).not.toContain("/audit");
    expect(help).not.toContain("/mcp");
  });

  test("/logs is registered, gated by audit:read, hidden from endusers", () => {
    const logs = findSlashCommand("logs");
    expect(logs).toBeDefined();
    expect(logs?.requires).toBe("audit:read");
    expect(logs?.category).toBe("admin");
    const enduser = slashCommandsForPersona(endUserPersona).map((c) => c.name);
    expect(enduser).not.toContain("logs");
    const admin = slashCommandsForPersona(adminPersona).map((c) => c.name);
    expect(admin).toContain("logs");
  });

  test("/debug is registered for everyone (util) — no permission required", () => {
    const dbg = findSlashCommand("debug");
    expect(dbg).toBeDefined();
    expect(dbg?.requires).toBeUndefined();
    expect(dbg?.category).toBe("util");
    const enduser = slashCommandsForPersona(endUserPersona).map((c) => c.name);
    expect(enduser).toContain("debug");
  });
});
