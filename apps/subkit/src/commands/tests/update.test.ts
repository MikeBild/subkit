import { describe, expect, test } from "bun:test";
import { updateCommand } from "../update.ts";

const cmd = updateCommand as unknown as {
  meta: { name: string; description: string };
  args: Record<string, { type: string; default?: unknown; description?: string }>;
};

describe("subkit update command", () => {
  test("exports an updateCommand object", () => {
    expect(updateCommand).toBeDefined();
  });

  test("meta.name is 'update'", () => {
    expect(cmd.meta.name).toBe("update");
  });

  test("meta.description mentions updating", () => {
    expect(cmd.meta.description.toLowerCase()).toContain("update");
  });

  test("has force boolean arg", () => {
    expect(cmd.args.force).toBeDefined();
    expect(cmd.args.force!.type).toBe("boolean");
  });

  test("has check boolean arg", () => {
    expect(cmd.args.check).toBeDefined();
    expect(cmd.args.check!.type).toBe("boolean");
  });

  test("has match-engine boolean arg", () => {
    expect(cmd.args["match-engine"]?.type).toBe("boolean");
  });

  test("names no version number in its help", () => {
    for (const arg of Object.values(cmd.args)) {
      expect(arg.description ?? "").not.toMatch(/\d+\.\d+\.\d+/);
    }
  });
});
