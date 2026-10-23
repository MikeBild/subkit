import { describe, expect, test } from "bun:test";
import { splitLeadingOptions } from "./leading-options.ts";

const defs = {
  profile: { type: "string" },
  "engine-url": { type: "string" },
  p: { type: "string" },
  c: { type: "boolean" },
  "no-memory": { type: "boolean" },
};

describe("splitLeadingOptions", () => {
  test("finds the command after value options", () => {
    expect(splitLeadingOptions(["--profile", "prod", "settings", "set", "a", "1"], defs)).toEqual({
      leading: ["--profile", "prod"],
      command: "settings",
      rest: ["set", "a", "1"],
    });
  });

  test("keeps inline values and boolean flags as single tokens", () => {
    expect(
      splitLeadingOptions(["--engine-url=http://x", "-c", "--no-memory", "stats"], defs),
    ).toEqual({
      leading: ["--engine-url=http://x", "-c", "--no-memory"],
      command: "stats",
      rest: [],
    });
  });

  test("treats the value of a string option as a value, not as the command", () => {
    expect(splitLeadingOptions(["-p", "settings"], defs).command).toBeUndefined();
  });

  test("returns the first token when no option leads", () => {
    expect(splitLeadingOptions(["settings", "list"], defs)).toEqual({
      leading: [],
      command: "settings",
      rest: ["list"],
    });
  });

  test("stops at the argument separator", () => {
    expect(splitLeadingOptions(["--", "settings"], defs)).toEqual({
      leading: [],
      command: "--",
      rest: ["settings"],
    });
  });
});
