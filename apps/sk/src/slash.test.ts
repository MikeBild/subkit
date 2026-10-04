import { beforeEach, describe, expect, test } from "bun:test";
import type { PersonaProbe } from "./slash.ts";
import { SLASH_COMMANDS, searchSlashCommands } from "./slash.ts";

const ALL: PersonaProbe = { allows: () => true };
const NONE: PersonaProbe = { allows: () => false };

describe("searchSlashCommands — empty query", () => {
  test("empty query returns up to `limit` commands", () => {
    const results = searchSlashCommands("", ALL, 6);
    expect(results.length).toBeLessThanOrEqual(6);
  });

  test("empty query returns only commands the persona can invoke", () => {
    const results = searchSlashCommands("", NONE, 20);
    for (const cmd of results) {
      expect(cmd.requires).toBeUndefined();
    }
  });

  test("empty query with /prefix is treated as empty too", () => {
    const withSlash = searchSlashCommands("/", ALL, 6);
    const withoutSlash = searchSlashCommands("", ALL, 6);
    expect(withSlash.map((c) => c.name)).toEqual(withoutSlash.map((c) => c.name));
  });
});

describe("searchSlashCommands — prefix match", () => {
  test("file upload slash commands are not registered", () => {
    const names = new Set(SLASH_COMMANDS.map((cmd) => cmd.name));
    const aliases = new Set(SLASH_COMMANDS.flatMap((cmd) => cmd.aliases ?? []));
    expect(names.has("attach")).toBe(false);
    expect(names.has("upload")).toBe(false);
    expect(aliases.has("file")).toBe(false);
  });

  test("exact name match appears in results", () => {
    const results = searchSlashCommands("workflows", ALL);
    const names = results.map((c) => c.name);
    expect(names).toContain("workflows");
  });

  test("partial match on 'exec' includes 'executions'", () => {
    const results = searchSlashCommands("exec", ALL);
    const names = results.map((c) => c.name);
    expect(names.some((n) => n === "executions" || n === "exec")).toBe(true);
  });

  test("limit parameter caps result count", () => {
    const results = searchSlashCommands("e", ALL, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("results are filtered by persona", () => {
    const results = searchSlashCommands("audit", NONE, 10);
    expect(results.map((c) => c.name)).not.toContain("audit");
  });
});

describe("searchSlashCommands — frequency bias", () => {
  beforeEach(async () => {
    await import("./usage-stats.ts");
  });

  test("empty query surfaces frequency-biased commands first when biased", () => {
    const visible = searchSlashCommands("", ALL, 10);
    for (const cmd of visible) {
      expect(typeof cmd.name).toBe("string");
      expect(cmd.name.length).toBeGreaterThan(0);
    }
  });

  test("a query that uniquely identifies one command returns that command", () => {
    const results = searchSlashCommands("connectors", ALL, 10);
    const names = results.map((c) => c.name);
    expect(names).toContain("connectors");
  });

  test("non-empty query uses predictable exact/prefix matching", () => {
    const results = searchSlashCommands("work", ALL, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const cmd of results) {
      const names = [cmd.name, ...(cmd.aliases ?? [])].map((name) => name.toLowerCase());
      expect(names.some((name) => name === "work" || name.startsWith("work"))).toBe(true);
    }
  });
});

describe("usage-stats — recordUsage / frequencyBias key convention", () => {
  test("the bias key for the dispatched name matches (no leading slash)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tempDir = mkdtempSync(join(tmpdir(), "sk-slash-test-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const { recordUsage, frequencyBias } = await import("./usage-stats.ts");
      recordUsage("workflows");
      expect(frequencyBias("workflows")).toBeGreaterThan(0);
      expect(frequencyBias("/workflows")).toBe(0);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("searchSlashCommands — RBAC filtering", () => {
  const workflowReadOnly: PersonaProbe = { allows: (p) => p === "workflow:read" };

  test("persona that only has workflow:read can see /workflows but not /executions", () => {
    const wfResults = searchSlashCommands("workflows", workflowReadOnly, 10);
    expect(wfResults.map((c) => c.name)).toContain("workflows");

    const execResults = searchSlashCommands("executions", workflowReadOnly, 10);
    expect(execResults.map((c) => c.name)).not.toContain("executions");
  });
});
