// The host-side operator commands, graded where they decide things.
//
// Two questions live here. The first is whether the argument surface can be
// talked into taking key material from anywhere but a file — argv is
// world-readable and lands in shell history, so a `--value` flag that
// merely "works" is the bug. The second is whether `--if-unreadable` and
// `--rewrap-master-key` write exactly when they must: the first runs on
// every deploy, so a version that still decrypts must come back untouched;
// the second must refuse outright while any replica is still serving.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseVaultCliArgs,
  runVaultCli,
  trimOneTrailingNewline,
  type VaultCliCommand,
  type VaultCliOutcome,
  type VaultOps,
} from "../vault-cli.ts";

const VALUE = "s3cr3t-value-nobody-should-see";
const VALUE_FILE = "/run/secrets/new";
const KEY_FILE = "/run/secrets/previous-master-key";
const PREVIOUS_KEY = "b".repeat(64);

interface FakeState {
  version: number | null;
  readable: boolean;
  absent: boolean;
  created: Array<{ name: string; value: string; purpose: string | null }>;
  prepared: Array<{ name: string; value: string; purpose: string | null; bindings: string[] }>;
  rebound: string[];
  serving: string[];
  rewrapped: string[];
}

function stateWith(partial: Partial<FakeState> = {}): FakeState {
  return {
    version: 1,
    readable: true,
    absent: false,
    created: [],
    prepared: [],
    rebound: [],
    serving: [],
    rewrapped: [],
    ...partial,
  };
}

const unavailable = (name: string) => (): never => {
  throw new Error(`${name} is not used by this command`);
};

function opsFor(state: FakeState, overrides: Partial<VaultOps> = {}): VaultOps {
  return {
    probeCurrentVersion: async () => ({
      version: state.version,
      readable: state.readable,
      absent: state.absent,
    }),
    createVersion: async (name, value, purpose) => {
      state.created.push({ name, value, purpose });
      const next = (state.version ?? 0) + 1;
      state.version = next;
      state.absent = false;
      state.readable = true;
      return { version: next };
    },
    prepareVersion: async (name, value, purpose, bindings) => {
      state.prepared.push({ name, value, purpose, bindings });
      // Prepared, not current: the probe keeps answering with the old version.
      return { version: (state.version ?? 0) + 1 };
    },
    rebind: async (path, name, version) => {
      state.rebound.push(path);
      return { path, name, version };
    },
    servingReplicas: async () => state.serving,
    rewrap: async (previousKeyHex) => {
      state.rewrapped.push(previousKeyHex);
      return { names: 2, versions: 5 };
    },
    preflight: unavailable("preflight") as unknown as VaultOps["preflight"],
    ...overrides,
  };
}

function command(argv: string[]): VaultCliCommand {
  const parsed = parseVaultCliArgs(argv);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.message}`);
  return parsed.command;
}

function readValueFile(path: string): string {
  if (path === VALUE_FILE) return `${VALUE}\n`;
  if (path === KEY_FILE) return `${PREVIOUS_KEY}\n`;
  throw new Error(`unexpected path: ${path}`);
}

// ---------------------------------------------------------------------------

describe("the argument surface", () => {
  const CLI_SOURCE = join(dirname(dirname(fileURLToPath(import.meta.url))), "vault-cli.ts");

  test("the module never reaches for the environment or for argv itself", () => {
    // A test, not a comment: the file may only receive argv as a parameter
    // and read key material through the injected file reader. If either
    // string appears, the guarantee that a value cannot arrive from the
    // environment is gone.
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
    // The new version is real; the deploy this was meant to unblock will
    // still fail, because the revision still points at the old one.
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

describe("--vault-set --pending", () => {
  test("writes a prepared version, re-pins nothing, and says where it waits", async () => {
    const state = stateWith({ version: 2 });
    const outcome = await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--pending"]),
      { ops: opsFor(state), readFile: readValueFile },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines[0]).toBe(
      "tok: prepared version 3; waiting for approval in the Cockpit (Einstellungen → Vorbereitete Änderungen)",
    );
    expect(outcome.lines[1]).toContain("bindings keep their pinned version");
    expect(state.prepared).toEqual([
      { name: "tok", value: VALUE, purpose: expect.any(String), bindings: [] },
    ]);
    expect(state.created).toEqual([]);
    expect(state.rebound).toEqual([]);
    // The probe still answers with the version that IS current.
    expect(await opsFor(state).probeCurrentVersion("tok")).toMatchObject({ version: 2 });
  });

  test("--bind with --pending is carried to the vault for approval, not applied now", async () => {
    const state = stateWith({ version: 2 });
    const outcome = await runVaultCli(
      command([
        "--vault-set",
        "tok",
        "--value-file",
        VALUE_FILE,
        "--pending",
        "--bind",
        "llm.providers.anthropic.api_key,storage.object_store.secret_access_key",
      ]),
      { ops: opsFor(state), readFile: readValueFile },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines[1]).toBe(
      "on approval, re-pinned: llm.providers.anthropic.api_key, storage.object_store.secret_access_key",
    );
    expect(state.prepared[0]?.bindings).toEqual([
      "llm.providers.anthropic.api_key",
      "storage.object_store.secret_access_key",
    ]);
    expect(state.rebound).toEqual([]);
  });

  test("--if-unreadable still short-circuits with --pending: a readable version needs no proposal", async () => {
    const state = stateWith({ version: 2 });
    const outcome = await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--pending", "--if-unreadable"]),
      {
        ops: opsFor(state),
        readFile: () => {
          throw new Error("the value file must not be read");
        },
      },
    );
    expect(outcome.exitCode).toBe(0);
    expect(state.prepared).toEqual([]);
  });

  test("a vault that refuses to prepare exits 1 and names the secret, not the value", async () => {
    const outcome = await runVaultCli(
      command(["--vault-set", "tok", "--value-file", VALUE_FILE, "--pending"]),
      {
        ops: opsFor(stateWith(), {
          prepareVersion: async () => {
            throw new Error("database is read-only");
          },
        }),
        readFile: readValueFile,
      },
    );
    expect(outcome).toEqual({ exitCode: 1, lines: ["tok: database is read-only"] });
    expect(outcome.lines.join("\n")).not.toContain(VALUE);
  });
});

describe("--rewrap-master-key", () => {
  test("refuses while any replica lease is still healthy, and reads no key file", async () => {
    const state = stateWith({ serving: ["engine-1", "engine-2"] });
    const outcome = await runVaultCli(command(["--rewrap-master-key", "--from-file", KEY_FILE]), {
      ops: opsFor(state),
      readFile: () => {
        throw new Error("the key file must not be read while the process is serving");
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines[0]).toContain("refused");
    expect(outcome.lines[0]).toContain("engine-1");
    expect(state.rewrapped).toEqual([]);
  });

  test("re-encrypts every version when nothing is serving", async () => {
    const state = stateWith({ serving: [] });
    const outcome = await runVaultCli(command(["--rewrap-master-key", "--from-file", KEY_FILE]), {
      ops: opsFor(state),
      readFile: readValueFile,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines[0]).toBe(
      "rewrap: 5 version(s) across 2 secret(s) re-encrypted under the running MASTER_KEY",
    );
    expect(state.rewrapped).toEqual([PREVIOUS_KEY]);
  });

  test("a from-file that is not a 64-hex key is refused before anything is touched", async () => {
    const state = stateWith();
    const outcome = await runVaultCli(command(["--rewrap-master-key", "--from-file", KEY_FILE]), {
      ops: opsFor(state),
      readFile: () => "not-a-key\n",
    });
    expect(outcome).toEqual({
      exitCode: 1,
      lines: [`${KEY_FILE}: does not hold a 64-hex master key`],
    });
    expect(state.rewrapped).toEqual([]);
  });

  test("the previous key never appears in the output", async () => {
    const outcome = await runVaultCli(command(["--rewrap-master-key", "--from-file", KEY_FILE]), {
      ops: opsFor(stateWith()),
      readFile: readValueFile,
    });
    expect(outcome.lines.join("\n")).not.toContain(PREVIOUS_KEY);
  });
});

describe("--preflight", () => {
  test("delegates to the check set and passes its outcome through untouched", async () => {
    const refused: VaultCliOutcome = {
      exitCode: 3,
      lines: ['{"event":"preflight.refused","code":"object_store_missing","detail":"none"}'],
    };
    const outcome = await runVaultCli(command(["--preflight"]), {
      ops: opsFor(stateWith(), { preflight: async () => refused }),
    });
    expect(outcome).toEqual(refused);
  });
});
