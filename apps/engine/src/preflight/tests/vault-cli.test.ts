import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVaultCliArgs, runVaultCli, trimOneTrailingNewline } from "../vault-cli.ts";
import {
  command,
  KEY_FILE,
  opsFor,
  PREVIOUS_KEY,
  readValueFile,
  stateWith,
  VALUE,
  VALUE_FILE,
} from "./vault-cli-fixtures.ts";

describe("the argument surface", () => {
  const CLI_SOURCE = join(dirname(dirname(fileURLToPath(import.meta.url))), "vault-cli.ts");

  test("the module never reaches for the environment or for argv itself", () => {
    const source = readFileSync(CLI_SOURCE, "utf8");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("process.argv");
  });

  test.each([
    [["--vault-set", "token", "--value", VALUE], "value flag"],
    [["--vault-set", "token", `--value=${VALUE}`, "--value-file", VALUE_FILE], "value= flag"],
    [["--vault-set", "token", "--secret-value", VALUE], "secret-value flag"],
    [["--rewrap-master-key", "--previous-key", PREVIOUS_KEY], "previous-key flag"],
    [["--rewrap-master-key", "--master-key", PREVIOUS_KEY], "master-key flag"],
    [["--vault-set", "token", "--value-file", VALUE_FILE, "--vault-check", "token"], "two modes"],
    [["--preflight", "--vault-check", "token"], "preflight plus a mode"],
    [["--vault-set", "token"], "set without a value file"],
    [["--vault-set"], "set without a name"],
    [["--vault-check"], "check without a name"],
    [["--vault-check", "token", "--value-file", VALUE_FILE], "check with a value file"],
    [["--vault-check", "token", "--bind", "a"], "check with a bind"],
    [["--vault-check", "token", "--if-unreadable"], "check with if-unreadable"],
    [["--vault-check", "token", "--pending"], "check with pending"],
    [["--preflight", "--pending"], "preflight with pending"],
    [["--rewrap-master-key", "--from-file", KEY_FILE, "--pending"], "rewrap with pending"],
    [["--preflight", "--bind", "a"], "preflight with a bind"],
    [["--rewrap-master-key"], "rewrap without a from-file"],
    [["--rewrap-master-key", "--from-file", KEY_FILE, "--bind", "a"], "rewrap with a bind"],
    [["--vault-set", "token", "--value-file", VALUE_FILE, "--bind", "a,,b"], "gap in bind"],
    [
      ["--vault-set", "token", "--value-file", VALUE_FILE, "--from-file", KEY_FILE],
      "set with from-file",
    ],
    [["--force"], "unknown argument"],
    [[], "no mode at all"],
  ])("refuses %o (%s)", (argv, _label) => {
    expect(parseVaultCliArgs(argv as string[]).ok).toBe(false);
  });

  test("--bind accumulates, splits on commas, trims and de-duplicates in first-seen order", () => {
    const parsed = command([
      "--vault-set",
      "token",
      "--value-file",
      VALUE_FILE,
      "--bind",
      " b , a ",
      "--bind",
      "a,c",
    ]);
    expect(parsed).toMatchObject({ mode: "set", bindings: ["b", "a", "c"] });
  });

  test("one trailing newline is stripped; a second is a real character of the value", () => {
    expect(trimOneTrailingNewline("v\n")).toBe("v");
    expect(trimOneTrailingNewline("v\r\n")).toBe("v");
    expect(trimOneTrailingNewline("v\n\n")).toBe("v\n");
    expect(trimOneTrailingNewline("v")).toBe("v");
  });
});

describe("--vault-check", () => {
  test("a readable current version exits 0", async () => {
    const outcome = await runVaultCli(command(["--vault-check", "tok"]), {
      ops: opsFor(stateWith({ version: 4 })),
    });
    expect(outcome).toEqual({ exitCode: 0, lines: ["tok: readable (version 4)"] });
  });

  test("an unreadable current version exits 3 and names the version", async () => {
    const outcome = await runVaultCli(command(["--vault-check", "tok"]), {
      ops: opsFor(stateWith({ version: 3, readable: false })),
    });
    expect(outcome).toEqual({ exitCode: 3, lines: ["tok: unreadable (version 3)"] });
  });

  test("a name whose every version is revoked exits 3 with no version", async () => {
    const outcome = await runVaultCli(command(["--vault-check", "tok"]), {
      ops: opsFor(stateWith({ version: null, readable: false })),
    });
    expect(outcome).toEqual({ exitCode: 3, lines: ["tok: unreadable (no version)"] });
  });

  test("a name that does not exist exits 3 and says so distinctly", async () => {
    const outcome = await runVaultCli(command(["--vault-check", "tok"]), {
      ops: opsFor(stateWith({ absent: true, version: null, readable: false })),
    });
    expect(outcome).toEqual({ exitCode: 3, lines: ["tok: absent (no such secret)"] });
  });

  test("a probe that throws exits 1 — a broken check is not an unreadable secret", async () => {
    const outcome = await runVaultCli(command(["--vault-check", "tok"]), {
      ops: opsFor(stateWith(), {
        probeCurrentVersion: async () => {
          throw new Error("connection reset");
        },
      }),
    });
    expect(outcome).toEqual({ exitCode: 1, lines: ["tok: check failed — connection reset"] });
  });
});

describe("--vault-set", () => {
  test("a name with no versions is created", async () => {
    const state = stateWith({ absent: true, version: null, readable: false });
    const outcome = await runVaultCli(command(["--vault-set", "tok", "--value-file", VALUE_FILE]), {
      ops: opsFor(state),
      readFile: readValueFile,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines[0]).toBe("tok: created at version 1");
    expect(state.created).toEqual([
      {
        name: "tok",
        value: VALUE,
        purpose: "created by a host-side rotation (engine --vault-set)",
      },
    ]);
  });

  test("an existing name is rotated to the next immutable version", async () => {
    const state = stateWith({ version: 7 });
    const outcome = await runVaultCli(command(["--vault-set", "tok", "--value-file", VALUE_FILE]), {
      ops: opsFor(state),
      readFile: readValueFile,
    });
    expect(outcome.lines[0]).toBe("tok: rotated to version 8");
  });

  test("without --bind it says so, because a pinned revision does not follow", async () => {
    const outcome = await runVaultCli(command(["--vault-set", "tok", "--value-file", VALUE_FILE]), {
      ops: opsFor(stateWith()),
      readFile: readValueFile,
    });
    expect(outcome.lines).toContain(
      "bindings keep their pinned version; re-run with --bind <binding> to re-pin them",
    );
  });

  test("--purpose reaches the vault; an empty one falls back to the default", async () => {
    const state = stateWith();
    await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--purpose", "incident 4711"]),
      { ops: opsFor(state), readFile: readValueFile },
    );
    expect(state.created[0]?.purpose).toBe("incident 4711");
  });

  test("--bind re-points each named settings path at the new version", async () => {
    const state = stateWith({ version: 2 });
    const outcome = await runVaultCli(
      command([
        "--vault-set",
        "tok",
        "--value-file",
        VALUE_FILE,
        "--bind",
        "llm.providers.anthropic.api_key",
      ]),
      { ops: opsFor(state), readFile: readValueFile },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines).toContain("llm.providers.anthropic.api_key: pinned to tok version 3");
    expect(state.rebound).toEqual(["llm.providers.anthropic.api_key"]);
  });

  test("a binding that could not be re-pinned exits 1 even though the version exists", async () => {
    const outcome = await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--bind", "no.such.path"]),
      {
        ops: opsFor(stateWith(), {
          rebind: async () => {
            throw new Error("unknown setting path: no.such.path");
          },
        }),
        readFile: readValueFile,
      },
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines[0]).toBe("tok: rotated to version 2");
    expect(outcome.lines).toContain(
      "no.such.path: not re-pinned — unknown setting path: no.such.path",
    );
  });

  test("--if-unreadable on a readable version does not even READ the value file", async () => {
    const state = stateWith({ version: 1, readable: true });
    const outcome = await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--if-unreadable"]),
      {
        ops: opsFor(state),
        readFile: () => {
          throw new Error("the value file must not even be read when nothing needs writing");
        },
      },
    );
    expect(outcome).toEqual({
      exitCode: 0,
      lines: ["tok: current version is readable; nothing changed (version 1)"],
    });
    expect(state.created).toEqual([]);
  });

  test("--if-unreadable on an unreadable version does write", async () => {
    const state = stateWith({ version: 1, readable: false });
    const outcome = await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--if-unreadable"]),
      { ops: opsFor(state), readFile: readValueFile },
    );
    expect(outcome.exitCode).toBe(0);
    expect(state.created).toHaveLength(1);
  });

  test("--if-unreadable on an absent name still creates it", async () => {
    const state = stateWith({ absent: true, version: null, readable: false });
    await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--if-unreadable"]),
      { ops: opsFor(state), readFile: readValueFile },
    );
    expect(state.created).toHaveLength(1);
  });

  test("an empty value file is a failure, not an empty secret", async () => {
    const outcome = await runVaultCli(command(["--vault-set", "tok", "--value-file", VALUE_FILE]), {
      ops: opsFor(stateWith()),
      readFile: () => "\n",
    });
    expect(outcome).toEqual({ exitCode: 1, lines: [`${VALUE_FILE}: holds no value`] });
  });

  test("an unreadable value file is reported by path, never by content", async () => {
    const outcome = await runVaultCli(command(["--vault-set", "tok", "--value-file", VALUE_FILE]), {
      ops: opsFor(stateWith()),
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(outcome).toEqual({ exitCode: 1, lines: [`${VALUE_FILE}: cannot be read — ENOENT`] });
  });

  test("no output line ever contains the value", async () => {
    const outcome = await runVaultCli(
      command([
        "--vault-set",
        "tok",
        "--value-file",
        VALUE_FILE,
        "--bind",
        "a",
        "--purpose",
        "why",
      ]),
      { ops: opsFor(stateWith()), readFile: readValueFile },
    );
    expect(outcome.lines.join("\n")).not.toContain(VALUE);
  });
});
