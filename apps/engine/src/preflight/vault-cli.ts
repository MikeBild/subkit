// The operator commands the bootstrap-preflight contract requires, as a
// pure module: argv in, `{exitCode, lines}` out.
//
//     engine --preflight
//     engine --vault-check <name>
//     engine --vault-set <name> --value-file <path> [--bind <b>,…] [--purpose "…"] [--if-unreadable]
//                                [--pending]
//     engine --rewrap-master-key --from-file <path-to-previous-key>
//
// WHY the way back in exists at all: a runtime secret version written under
// an earlier MASTER_KEY cannot be decrypted by this process, and the
// bootstrap preflight then refuses to start (`secret_unreadable`) — which
// is the correct refusal and also a deadlock, because the HTTP settings
// surface needs a running engine. These commands run on the host, where
// the caller already holds MASTER_KEY, DATABASE_URL and a shell: a higher
// bar than any API key.
//
// This module never reads the process environment and never reads the
// process argument vector itself — argv arrives as a parameter and every
// effect arrives through `VaultOps`. That is asserted by a test which scans
// this file's source for both accessors, because it is the property keeping
// the secret value out of argv and out of the environment. Which is also
// why neither accessor is spelled out above: the scan is literal.

import { readFileSync } from "node:fs";

const VALUE_BEARING_FLAGS = ["--value", "--secret-value", "--previous-key", "--master-key"];

export interface VaultCheckCommand {
  mode: "check";
  name: string;
}

export interface VaultSetCommand {
  mode: "set";
  name: string;
  valueFile: string;
  bindings: string[];
  purpose: string | null;
  ifUnreadable: boolean;
  /**
   * Write the version but do not make it current and do not re-pin: it waits
   * in the Cockpit as a prepared change until a person approves it. `--bind`
   * then names what approval re-pins.
   */
  pending: boolean;
}

export interface RewrapCommand {
  mode: "rewrap";
  fromFile: string;
}

export interface PreflightCommand {
  mode: "preflight";
}

export type VaultCliCommand =
  | VaultCheckCommand
  | VaultSetCommand
  | RewrapCommand
  | PreflightCommand;

export type VaultCliParse = { ok: true; command: VaultCliCommand } | { ok: false; message: string };

/** The flags this module owns. `index.ts` dispatches on these. */
export const VAULT_CLI_FLAGS = [
  "--preflight",
  "--vault-check",
  "--vault-set",
  "--rewrap-master-key",
] as const;

// No "Usage:" header of its own — `--help` owns one already and the error
// path adds one. Two headers on one screen is how a help text starts lying.
export const VAULT_CLI_USAGE: string = [
  "  engine --preflight",
  "      can this release run on this bootstrap? changes nothing",
  "  engine --vault-check <name>",
  "      is this secret still readable? changes nothing",
  "  engine --vault-set <name> --value-file <path> [--bind <setting.path>[,…]]",
  '                            [--purpose "<text>"] [--if-unreadable] [--pending]',
  "      put a new value in; writes a new version of the secret",
  "      --pending: write it, but let a person approve it in the Cockpit",
  "      before it is used; --bind then says what approval re-pins",
  "  engine --rewrap-master-key --from-file <path-to-previous-key>",
  "      re-encrypt every stored secret under the new MASTER_KEY;",
  "      stop all engines first",
  "",
  "The secret value and the previous key are read from a file only — never from",
  "an argument and never from the environment. One trailing newline is stripped.",
  "--bind takes dotted settings paths; each is re-pointed at the new version.",
].join("\n");

function fail(message: string): VaultCliParse {
  return { ok: false, message };
}

export function parseVaultCliArgs(argv: string[]): VaultCliParse {
  let mode: VaultCliCommand["mode"] | null = null;
  let name: string | undefined;
  let valueFile: string | undefined;
  let fromFile: string | undefined;
  let purpose: string | null = null;
  let ifUnreadable = false;
  let pending = false;
  const bindings: string[] = [];

  const takeValue = (index: number): string | undefined => {
    const next = argv[index + 1];
    return next === undefined || next.startsWith("--") ? undefined : next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (VALUE_BEARING_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`))) {
      return fail(
        "key material is never taken from an argument — write it to a file and pass --value-file or --from-file",
      );
    }
    switch (token) {
      case "--preflight": {
        if (mode !== null)
          return fail(
            "pass exactly one of --preflight, --vault-check, --vault-set or --rewrap-master-key",
          );
        mode = "preflight";
        break;
      }
      case "--vault-check":
      case "--vault-set": {
        if (mode !== null)
          return fail(
            "pass exactly one of --preflight, --vault-check, --vault-set or --rewrap-master-key",
          );
        mode = token === "--vault-check" ? "check" : "set";
        name = takeValue(i);
        if (name === undefined) return fail(`${token} needs a secret name`);
        i += 1;
        break;
      }
      case "--rewrap-master-key": {
        if (mode !== null)
          return fail(
            "pass exactly one of --preflight, --vault-check, --vault-set or --rewrap-master-key",
          );
        mode = "rewrap";
        break;
      }
      case "--value-file": {
        valueFile = takeValue(i);
        if (valueFile === undefined) return fail("--value-file needs a path");
        i += 1;
        break;
      }
      case "--from-file": {
        fromFile = takeValue(i);
        if (fromFile === undefined) return fail("--from-file needs a path");
        i += 1;
        break;
      }
      case "--bind": {
        const raw = takeValue(i);
        if (raw === undefined) return fail("--bind needs at least one setting path");
        const parts = raw.split(",").map((part) => part.trim());
        if (parts.some((part) => part.length === 0)) {
          return fail("--bind takes a comma-separated list without gaps");
        }
        for (const part of parts) if (!bindings.includes(part)) bindings.push(part);
        i += 1;
        break;
      }
      case "--purpose": {
        const raw = takeValue(i);
        if (raw === undefined) return fail("--purpose needs a text");
        purpose = raw;
        i += 1;
        break;
      }
      case "--if-unreadable": {
        ifUnreadable = true;
        break;
      }
      case "--pending": {
        pending = true;
        break;
      }
      default:
        return fail(`unknown argument: ${token}`);
    }
  }

  if (mode === null) {
    return fail(
      "pass --preflight, --vault-check <name>, --vault-set <name> or --rewrap-master-key",
    );
  }

  const extras = (): string | null => {
    if (valueFile !== undefined) return "--value-file";
    if (fromFile !== undefined) return "--from-file";
    if (bindings.length) return "--bind";
    if (purpose !== null) return "--purpose";
    if (ifUnreadable) return "--if-unreadable";
    if (pending) return "--pending";
    return null;
  };

  if (mode === "preflight") {
    const extra = extras();
    if (extra) return fail(`--preflight only reads; it takes no ${extra}`);
    return { ok: true, command: { mode: "preflight" } };
  }

  if (mode === "check") {
    if (
      valueFile !== undefined ||
      fromFile !== undefined ||
      bindings.length ||
      purpose !== null ||
      ifUnreadable ||
      pending
    ) {
      return fail(
        "--vault-check only reads; it takes no --value-file, --from-file, --bind, --purpose, --if-unreadable or --pending",
      );
    }
    return { ok: true, command: { mode: "check", name: name! } };
  }

  if (mode === "rewrap") {
    if (fromFile === undefined) return fail("--rewrap-master-key needs --from-file <path>");
    if (valueFile !== undefined || bindings.length || purpose !== null || ifUnreadable || pending) {
      return fail("--rewrap-master-key takes only --from-file");
    }
    return { ok: true, command: { mode: "rewrap", fromFile } };
  }

  if (fromFile !== undefined)
    return fail("--vault-set reads its value from --value-file, not --from-file");
  if (valueFile === undefined) return fail("--vault-set needs --value-file <path>");
  return {
    ok: true,
    command: { mode: "set", name: name!, valueFile, bindings, purpose, ifUnreadable, pending },
  };
}

/** Strip exactly one trailing newline, so `printf '%s\n' > file` and a raw write agree. */
export function trimOneTrailingNewline(raw: string): string {
  if (raw.endsWith("\r\n")) return raw.slice(0, -2);
  if (raw.endsWith("\n")) return raw.slice(0, -1);
  return raw;
}

export interface VaultCliOutcome {
  /** 0 done or nothing to do, 1 failure, 3 the current version does not decrypt / the preflight refused. */
  exitCode: 0 | 1 | 3;
  lines: string[];
}

export interface VersionProbe {
  /** The highest non-revoked version, or null when the name has none. */
  version: number | null;
  readable: boolean;
  /** True when the name has no rows at all. */
  absent: boolean;
}

export interface Rebound {
  path: string;
  name: string;
  version: number;
}

/**
 * Every effect the commands have, injected. The production implementation
 * is `vault-ops.ts`; tests pass a fake and assert on the lines.
 */
export interface VaultOps {
  probeCurrentVersion(name: string): Promise<VersionProbe>;
  /** Mint the next immutable version of `name`. `purpose` is audited, never stored beside the ciphertext. */
  createVersion(name: string, value: string, purpose: string | null): Promise<{ version: number }>;
  /**
   * Mint the next version as a PREPARED one: not current, not bound, waiting
   * for a person in the Cockpit. `bindings` are re-pinned on approval.
   */
  prepareVersion(
    name: string,
    value: string,
    purpose: string | null,
    bindings: string[],
  ): Promise<{ version: number }>;
  /** Re-point one dotted settings path at `secret://name/version` in a new revision. */
  rebind(path: string, name: string, version: number): Promise<Rebound>;
  /** Instance ids whose replica lease is still healthy. Non-empty means the process is serving. */
  servingReplicas(): Promise<string[]>;
  /** Re-encrypt every stored version under the running key, reading with `previousKeyHex`. */
  rewrap(previousKeyHex: string): Promise<{ names: number; versions: number }>;
  /** Run the six checks. */
  preflight(): Promise<VaultCliOutcome>;
}

export interface VaultCliDeps {
  ops: VaultOps;
  readFile?(path: string): string;
}

const DEFAULT_PURPOSE = "created by a host-side rotation (engine --vault-set)";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCheck(command: VaultCheckCommand, deps: VaultCliDeps): Promise<VaultCliOutcome> {
  try {
    const probe = await deps.ops.probeCurrentVersion(command.name);
    if (probe.absent) {
      return { exitCode: 3, lines: [`${command.name}: absent (no such secret)`] };
    }
    if (probe.readable) {
      return { exitCode: 0, lines: [`${command.name}: readable (version ${probe.version})`] };
    }
    return {
      exitCode: 3,
      lines: [
        probe.version === null
          ? `${command.name}: unreadable (no version)`
          : `${command.name}: unreadable (version ${probe.version})`,
      ],
    };
  } catch (error) {
    return { exitCode: 1, lines: [`${command.name}: check failed — ${messageOf(error)}`] };
  }
}

async function runSet(command: VaultSetCommand, deps: VaultCliDeps): Promise<VaultCliOutcome> {
  const { ops } = deps;
  const lines: string[] = [];

  let probe: VersionProbe;
  try {
    probe = await ops.probeCurrentVersion(command.name);
  } catch (error) {
    return { exitCode: 1, lines: [`${command.name}: ${messageOf(error)}`] };
  }

  // `--if-unreadable` only short-circuits when the secret already exists.
  // A name with no version yet is always written, flag or not.
  if (command.ifUnreadable && !probe.absent && probe.readable) {
    return {
      exitCode: 0,
      lines: [
        `${command.name}: current version is readable; nothing changed (version ${probe.version})`,
      ],
    };
  }

  let value: string;
  try {
    const read = deps.readFile ?? defaultReadFile;
    // No attempt to scrub this afterwards: a JS string is immutable, so
    // reassigning the variable frees nothing, and a gesture that reads like
    // a guarantee without being one is worse than its absence.
    value = trimOneTrailingNewline(read(command.valueFile));
  } catch (error) {
    return { exitCode: 1, lines: [`${command.valueFile}: cannot be read — ${messageOf(error)}`] };
  }
  if (value.length === 0) return { exitCode: 1, lines: [`${command.valueFile}: holds no value`] };

  if (command.pending) {
    // A prepared version changes nothing yet, which is the whole point: the
    // value is in, encrypted, and the decision about using it is a person's.
    try {
      const prepared = await ops.prepareVersion(
        command.name,
        value,
        command.purpose || DEFAULT_PURPOSE,
        command.bindings,
      );
      lines.push(
        `${command.name}: prepared version ${prepared.version}; waiting for approval in the Cockpit (Einstellungen → Vorbereitete Änderungen)`,
      );
      lines.push(
        command.bindings.length
          ? `on approval, re-pinned: ${command.bindings.join(", ")}`
          : "on approval, bindings keep their pinned version; add --bind <setting.path> to re-pin them then",
      );
      return { exitCode: 0, lines };
    } catch (error) {
      return { exitCode: 1, lines: [`${command.name}: ${messageOf(error)}`] };
    }
  }

  let version: number;
  try {
    version = (await ops.createVersion(command.name, value, command.purpose || DEFAULT_PURPOSE))
      .version;
    lines.push(
      probe.absent
        ? `${command.name}: created at version ${version}`
        : `${command.name}: rotated to version ${version}`,
    );
  } catch (error) {
    return { exitCode: 1, lines: [`${command.name}: ${messageOf(error)}`] };
  }

  if (command.bindings.length === 0) {
    lines.push("bindings keep their pinned version; re-run with --bind <binding> to re-pin them");
    return { exitCode: 0, lines };
  }

  const failures: string[] = [];
  for (const binding of command.bindings) {
    try {
      const pinned = await ops.rebind(binding, command.name, version);
      lines.push(`${pinned.path}: pinned to ${pinned.name} version ${pinned.version}`);
    } catch (error) {
      failures.push(`${binding}: not re-pinned — ${messageOf(error)}`);
    }
  }
  lines.push(...failures);
  // The new version exists either way; a binding that could not be re-pinned
  // is still a failure, because the deploy it was meant to unblock will fail
  // again on the version the binding still points at.
  return { exitCode: failures.length ? 1 : 0, lines };
}

const MASTER_KEY_HEX = /^[0-9a-fA-F]{64}$/;

async function runRewrap(command: RewrapCommand, deps: VaultCliDeps): Promise<VaultCliOutcome> {
  const { ops } = deps;

  // Refuse while the process is serving. A rewrap rewrites the ciphertext
  // of every version in place; a replica still holding the old key in memory
  // would keep serving from a cache it can no longer refresh, and a replica
  // that restarts mid-sweep would read half a vault.
  let serving: string[];
  try {
    serving = await ops.servingReplicas();
  } catch (error) {
    return { exitCode: 1, lines: [`rewrap: ${messageOf(error)}`] };
  }
  if (serving.length > 0) {
    return {
      exitCode: 1,
      lines: [
        `rewrap: refused — ${serving.length} replica lease(s) are still healthy: ${serving.slice(0, 5).join(", ")}`,
        "stop every engine replica, then re-run; a rewrap must not race a process that is serving",
      ],
    };
  }

  let previous: string;
  try {
    const read = deps.readFile ?? defaultReadFile;
    previous = trimOneTrailingNewline(read(command.fromFile)).trim();
  } catch (error) {
    return { exitCode: 1, lines: [`${command.fromFile}: cannot be read — ${messageOf(error)}`] };
  }
  if (!MASTER_KEY_HEX.test(previous)) {
    return {
      exitCode: 1,
      lines: [`${command.fromFile}: does not hold a 64-hex master key`],
    };
  }

  try {
    const report = await ops.rewrap(previous);
    return {
      exitCode: 0,
      lines: [
        `rewrap: ${report.versions} version(s) across ${report.names} secret(s) re-encrypted under the running MASTER_KEY`,
      ],
    };
  } catch (error) {
    return { exitCode: 1, lines: [`rewrap: ${messageOf(error)}`] };
  }
}

/** The reader every test replaces. The path is the ONLY way a value gets in. */
function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

export async function runVaultCli(
  command: VaultCliCommand,
  deps: VaultCliDeps,
): Promise<VaultCliOutcome> {
  switch (command.mode) {
    case "preflight":
      return deps.ops.preflight();
    case "check":
      return runCheck(command, deps);
    case "set":
      return runSet(command, deps);
    case "rewrap":
      return runRewrap(command, deps);
  }
}
