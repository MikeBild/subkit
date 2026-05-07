import { describe, expect, test } from "bun:test";
import { hasCommand, resolveSlashCommand } from "../repl/slash/hasCommand.ts";
import type { PersonaProbe } from "../slash.ts";

const allOf = (...perms: string[]): PersonaProbe => {
  const set = new Set(perms);
  return { allows: (p: string) => set.has(p) };
};
const NONE: PersonaProbe = { allows: () => false };
const ALL: PersonaProbe = { allows: () => true };

describe("resolveSlashCommand", () => {
  test("resolves canonical name", () => {
    expect(resolveSlashCommand("help")?.name).toBe("help");
  });

  test("resolves alias to its canonical command", () => {
    // /clear has alias /new
    const cmd = resolveSlashCommand("new");
    expect(cmd?.name).toBe("clear");
  });

  test("returns undefined for unknown name", () => {
    expect(resolveSlashCommand("definitely-not-a-cmd")).toBeUndefined();
  });

  test("name lookup is case-insensitive", () => {
    expect(resolveSlashCommand("HELP")?.name).toBe("help");
  });

  test("empty name returns undefined", () => {
    expect(resolveSlashCommand("")).toBeUndefined();
  });
});

describe("hasCommand", () => {
  test("commands with no `requires` are always allowed", () => {
    expect(hasCommand("help", NONE)).toBe(true);
    expect(hasCommand("help", ALL)).toBe(true);
  });

  test("gated commands require the persona to allow the permission", () => {
    expect(hasCommand("clear", NONE)).toBe(false);
    expect(hasCommand("clear", allOf("conversation:write"))).toBe(true);
  });

  test("admin-only command refuses an enduser persona", () => {
    expect(hasCommand("audit", allOf("conversation:write"))).toBe(false);
    expect(hasCommand("audit", allOf("audit:read"))).toBe(true);
  });

  test("unknown command is always denied", () => {
    expect(hasCommand("ghost-command", ALL)).toBe(false);
  });
});
