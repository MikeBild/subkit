import { describe, expect, test } from "bun:test";
import { profileOption, repeatedOption, splitLeadingOptions } from "./leading-options.ts";

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

describe("profileOption", () => {
  test("reads a profile given after the command", () => {
    expect(profileOption(["workflows", "list", "--profile", "cloud"])).toBe("cloud");
  });

  test("reads the inline form", () => {
    expect(profileOption(["--profile=cloud", "connectors", "list"])).toBe("cloud");
  });

  test("ignores everything after the argument separator", () => {
    expect(profileOption(["run", "x", "--", "--profile", "cloud"])).toBeUndefined();
  });

  test("returns nothing without a profile", () => {
    expect(profileOption(["workflows", "list", "--json"])).toBeUndefined();
    expect(profileOption(["workflows", "--profile"])).toBeUndefined();
  });
});

describe("repeatedOption", () => {
  test("keeps every value of a repeated option in order", () => {
    expect(
      repeatedOption(
        ["--input-file", "order=a.pdf", "--input-file", "receipt=b.pdf"],
        "input-file",
      ),
    ).toEqual(["order=a.pdf", "receipt=b.pdf"]);
  });

  test("accepts inline values mixed with spaced ones", () => {
    expect(
      repeatedOption(["--attach=a.png", "wf", "--json", "--attach", "b.png"], "attach"),
    ).toEqual(["a.png", "b.png"]);
  });

  test("ignores similarly named options and everything after --", () => {
    expect(
      repeatedOption(["--attachment", "x", "--attach", "a", "--", "--attach", "b"], "attach"),
    ).toEqual(["a"]);
  });

  test("returns an empty list when absent or the value is missing", () => {
    expect(repeatedOption(["--json"], "attach")).toEqual([]);
    expect(repeatedOption(["--attach"], "attach")).toEqual([]);
  });
});
