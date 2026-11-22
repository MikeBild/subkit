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

describe("subkit slash registry", () => {
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
    expect(visible).toContain("clear");
    expect(visible).toContain("resume");
    expect(visible).toContain("draft");
    expect(visible).toContain("connector");
    expect(visible).toContain("workflow");
    expect(visible).toContain("context");
    expect(visible).toContain("help");
    expect(visible).toContain("model");
    expect(visible).toContain("compact");
    expect(visible).toContain("init");
    expect(visible).not.toContain("audit");
    expect(visible).not.toContain("mcp");
    expect(visible).not.toContain("skills");
    expect(visible).not.toContain("tenant");
    expect(visible).not.toContain("setup");
    expect(visible).not.toContain("approve");
    expect(visible).not.toContain("reject");
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

  test("/view is registered for everyone as a local transcript control", () => {
    const view = findSlashCommand("view");
    expect(view).toBeDefined();
    expect(view?.requires).toBeUndefined();
    expect(view?.category).toBe("util");
  });

  test("authoring inspection commands are registered and gated by conversation:read", () => {
    for (const name of ["draft", "connector", "workflow", "context", "approvals"] as const) {
      const cmd = findSlashCommand(name);
      expect(cmd).toBeDefined();
      expect(cmd?.requires).toBe("conversation:read");
    }
  });

  test("/setup is registered, gated by identity:read, visible to members but hidden from endusers", () => {
    const setup = findSlashCommand("setup");
    expect(setup).toBeDefined();
    expect(setup?.requires).toBe("identity:read");
    const member = slashCommandsForPersona({
      allows: (p) => p !== "audit:read",
    }).map((cmd) => cmd.name);
    expect(member).toContain("setup");
    const enduser = slashCommandsForPersona(endUserPersona).map((cmd) => cmd.name);
    expect(enduser).not.toContain("setup");
  });
});
