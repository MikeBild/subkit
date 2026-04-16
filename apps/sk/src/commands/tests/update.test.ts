import { describe, expect, test } from "bun:test";
import { updateCommand } from "../update.ts";

// Cast through unknown to avoid citty's complex generics in test assertions.
const cmd = updateCommand as unknown as {
  meta: { name: string; description: string };
  args: Record<string, { type: string; default?: unknown; description?: string }>;
};

describe("sk update command", () => {
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

  test("has channel string arg defaulting to stable", () => {
    expect(cmd.args.channel).toBeDefined();
    expect(cmd.args.channel!.type).toBe("string");
    expect(cmd.args.channel!.default).toBe("stable");
  });
});
