import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type CommandDef, runCommand } from "citty";
import { categoriesCommand } from "../commands/categories.ts";
import type { CatalogCategoryUsage } from "../engine-client/catalog.ts";
import { EngineClient } from "../engine-client.ts";

const emptyCounts = { workflow: 0, connector: 0, knowledge_source: 0, skill: 0, file: 0, task: 0 };
const intakeOnly: CatalogCategoryUsage = {
  category: "inbox",
  purpose: null,
  purpose_source: null,
  aliases: [],
  revision: 1,
  total: 1,
  counts: { ...emptyCounts, intake: 1 },
  llm_counts: { ...emptyCounts, intake: 0 },
  intake_open: { collected: 1, reviewing: 0 },
};

const envKeys = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

describe("sk categories list (#518)", () => {
  beforeEach(() => {
    process.env.SUBKIT_ENGINE_URL = "https://engine.test";
    process.env.SUBKIT_API_KEY = "test-key";
    process.env.SUBKIT_TENANT = "test-tenant";
  });
  afterEach(() => {
    for (const key of envKeys) {
      const savedValue = savedEnv[key];
      if (savedValue === undefined) delete process.env[key];
      else process.env[key] = savedValue;
    }
  });

  test("text output shows the intake column so counts add up to the total", async () => {
    const listSpy = spyOn(EngineClient.prototype, "listCategories").mockResolvedValue({
      categories: [intakeOnly],
    } as Awaited<ReturnType<EngineClient["listCategories"]>>);
    const writes: string[] = [];
    const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const logSpy = spyOn(console, "log").mockImplementation((...parts) => {
      writes.push(`${parts.join(" ")}\n`);
    });
    try {
      const subCommands = categoriesCommand.subCommands as Record<string, CommandDef>;
      await runCommand(subCommands.list as CommandDef, { rawArgs: [] });
    } finally {
      listSpy.mockRestore();
      writeSpy.mockRestore();
      logSpy.mockRestore();
    }
    const lines = writes.join("").split("\n").filter(Boolean);
    const header = lines.find((line) => line.includes("category")) ?? "";
    const row = lines.find((line) => line.includes("inbox")) ?? "";
    const headerCells = header.trim().split(/\s+/);
    const rowCells = row.trim().split(/\s+/);
    expect(headerCells).toContain("intake");
    expect(rowCells[headerCells.indexOf("intake")]).toBe("1");
  });
});
