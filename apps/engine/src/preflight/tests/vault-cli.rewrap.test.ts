import { describe, expect, test } from "bun:test";
import { syntheticVaultStopAcknowledgement } from "../../test-helpers/vault-maintenance.ts";
import {
  parseVaultCliArgs,
  runVaultCli,
  type VaultCliCommand,
  type VaultCliOutcome,
} from "../vault-cli.ts";
import {
  command,
  KEY_FILE,
  opsFor,
  PREVIOUS_KEY,
  readValueFile,
  STOP_EVIDENCE_FILE,
  stateWith,
  VALUE,
  VALUE_FILE,
} from "./vault-cli-fixtures.ts";

function rewrapArguments(): string[] {
  return [
    "--rewrap-master-key",
    "--from-file",
    KEY_FILE,
    "--all-producers-stopped",
    "--stop-evidence-file",
    STOP_EVIDENCE_FILE,
  ];
}

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
    const outcome = await runVaultCli(command(rewrapArguments()), {
      ops: opsFor(state),
      readFile: (path) => {
        if (path === STOP_EVIDENCE_FILE) return syntheticVaultStopAcknowledgement.evidence;
        throw new Error("the key file must not be read while the process is serving");
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines[0]).toContain("refused");
    expect(outcome.lines[0]).toContain("engine-1");
    expect(state.rewrapped).toEqual([]);
  });

  test("re-encrypts registry versions when nothing is serving", async () => {
    const state = stateWith({ serving: [] });
    const outcome = await runVaultCli(command(rewrapArguments()), {
      ops: opsFor(state),
      readFile: readValueFile,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines[0]).toBe(
      "rewrap: 5 version(s) across 2 registry secret(s) re-encrypted under the target MASTER_KEY",
    );
    expect(state.rewrapped).toEqual([PREVIOUS_KEY]);
  });

  test("a from-file that is not a 64-hex key is refused before anything is touched", async () => {
    const state = stateWith();
    const outcome = await runVaultCli(command(rewrapArguments()), {
      ops: opsFor(state),
      readFile: (path) =>
        path === STOP_EVIDENCE_FILE ? syntheticVaultStopAcknowledgement.evidence : "not-a-key\n",
    });
    expect(outcome).toEqual({
      exitCode: 1,
      lines: [`${KEY_FILE}: does not hold a 64-hex master key`],
    });
    expect(state.rewrapped).toEqual([]);
  });

  test("the previous key never appears in the output", async () => {
    const outcome = await runVaultCli(command(rewrapArguments()), {
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

test("rewrap parsing requires an explicit stop acknowledgement and a separate review file", () => {
  expect(parseVaultCliArgs(["--rewrap-master-key", "--from-file", KEY_FILE]).ok).toBe(false);
  expect(
    parseVaultCliArgs(["--rewrap-master-key", "--from-file", KEY_FILE, "--all-producers-stopped"])
      .ok,
  ).toBe(false);
  expect(
    parseVaultCliArgs([
      "--rewrap-master-key",
      "--from-file",
      KEY_FILE,
      "--all-producers-stopped",
      "--stop-evidence-file",
      KEY_FILE,
    ]).ok,
  ).toBe(false);
  expect(
    parseVaultCliArgs([
      "--rewrap-master-key",
      "--from-file",
      KEY_FILE,
      "--all-producers-stopped",
      "--stop-evidence-file",
      "/run/secrets/../secrets/previous-master-key",
    ]).ok,
  ).toBe(false);
  expect(parseVaultCliArgs(rewrapArguments()).ok).toBe(true);
});

test("missing runtime acknowledgement refuses before reading either review or key files", async () => {
  let reads = 0;
  const malformed = {
    mode: "rewrap",
    fromFile: KEY_FILE,
    stopEvidenceFile: STOP_EVIDENCE_FILE,
  } as VaultCliCommand;
  const outcome = await runVaultCli(malformed, {
    ops: opsFor(stateWith()),
    readFile: () => {
      reads++;
      return PREVIOUS_KEY;
    },
  });
  expect(outcome.exitCode).toBe(1);
  expect(reads).toBe(0);
});

test.each(["", "short evidence canary", "x".repeat(120), "evidence canary ".repeat(2000)])(
  "invalid stop review refuses without reading the key or exposing its body",
  async (evidence) => {
    const reads: string[] = [];
    const state = stateWith();
    const outcome = await runVaultCli(command(rewrapArguments()), {
      ops: opsFor(state),
      readFile: (path) => {
        reads.push(path);
        return evidence;
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(reads).toEqual([STOP_EVIDENCE_FILE]);
    expect(state.rewrapped).toEqual([]);
    expect(outcome.lines.join("\n")).not.toContain("canary");
  },
);

test("successful CLI handoff passes the explicit human attestation without printing it", async () => {
  const reads: string[] = [];
  const outcome = await runVaultCli(command(rewrapArguments()), {
    ops: opsFor(stateWith(), {
      rewrap: async (previous, acknowledgement) => {
        expect(previous).toBe(PREVIOUS_KEY);
        expect(acknowledgement).toEqual({
          ...syntheticVaultStopAcknowledgement,
          maintenance: false,
        });
        return { names: 1, versions: 2 };
      },
    }),
    readFile: (path) => {
      reads.push(path);
      return readValueFile(path);
    },
  });
  expect(reads).toEqual([STOP_EVIDENCE_FILE, KEY_FILE]);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.lines.join("\n")).not.toContain(syntheticVaultStopAcknowledgement.evidence);
  expect(outcome.lines.join("\n")).not.toContain(PREVIOUS_KEY);
});

test("maintenance selection is restricted to rewrap and rejects duplicate flags", () => {
  const parsed = parseVaultCliArgs([...rewrapArguments(), "--maintenance"]);
  expect(parsed.ok && parsed.command.mode === "rewrap" && parsed.command.maintenance).toBe(true);
  for (const argv of [
    ["--preflight"],
    ["--vault-check", "name"],
    ["--vault-set", "name", "--value-file", KEY_FILE],
    [...rewrapArguments(), "--maintenance"],
  ]) {
    expect(parseVaultCliArgs([...argv, "--maintenance"]).ok).toBe(false);
  }
});

test("maintenance handoff avoids table-reading replica checks and preserves the stop proof", async () => {
  let dispatched = false;
  const outcome = await runVaultCli(command([...rewrapArguments(), "--maintenance"]), {
    ops: opsFor(stateWith(), {
      servingReplicas: async () => {
        throw new Error("direct table access forbidden");
      },
      rewrap: async (previous, acknowledgement) => {
        dispatched = true;
        expect(previous).toBe(PREVIOUS_KEY);
        expect(acknowledgement).toEqual({
          ...syntheticVaultStopAcknowledgement,
          maintenance: true,
        });
        return { names: 1, versions: 1 };
      },
    }),
    readFile: readValueFile,
  });
  expect(dispatched).toBe(true);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.lines.join("\n")).not.toContain(syntheticVaultStopAcknowledgement.evidence);
  expect(outcome.lines.join("\n")).not.toContain(PREVIOUS_KEY);
});
