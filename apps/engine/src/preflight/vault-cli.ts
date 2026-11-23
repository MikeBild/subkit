import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type RewrapAcknowledgement, rewrapEvidenceDigest } from "./rewrap-evidence.ts";

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
  pending: boolean;
}

export interface RewrapCommand {
  mode: "rewrap";
  fromFile: string;
  allProducersStopped: true;
  stopEvidenceFile: string;
  maintenance: boolean;
}

export interface PreflightCommand {
  mode: "preflight";
}

export type VaultCliCommand =
  | VaultCheckCommand
  | VaultSetCommand
  | RewrapCommand
  | PreflightCommand;

type VaultCliParse = { ok: true; command: VaultCliCommand } | { ok: false; message: string };

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
  "      --all-producers-stopped --stop-evidence-file <separate-review-file>",
  "      [--maintenance: use the selected database maintenance login]",
  "      re-encrypt the settings-secret registry under the target MASTER_KEY;",
  "      refuses retained non-registry encrypted data or key-bound proofs",
  "      preserve the original MASTER_KEY if refused; stop all engines first",
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
  let stopEvidenceFile: string | undefined;
  let allProducersStopped = false;
  let maintenance = false;
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
      case "--maintenance": {
        if (maintenance) return fail("duplicate --maintenance");
        maintenance = true;
        break;
      }
      case "--all-producers-stopped": {
        if (allProducersStopped) return fail("duplicate --all-producers-stopped");
        allProducersStopped = true;
        break;
      }
      case "--stop-evidence-file": {
        if (stopEvidenceFile !== undefined) return fail("duplicate --stop-evidence-file");
        stopEvidenceFile = takeValue(i);
        if (stopEvidenceFile === undefined) return fail("--stop-evidence-file needs a path");
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
    if (maintenance) return "--maintenance";
    if (allProducersStopped) return "--all-producers-stopped";
    if (stopEvidenceFile !== undefined) return "--stop-evidence-file";
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
      maintenance ||
      allProducersStopped ||
      stopEvidenceFile !== undefined ||
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
    if (!allProducersStopped) return fail("--rewrap-master-key needs --all-producers-stopped");
    if (stopEvidenceFile === undefined)
      return fail("--rewrap-master-key needs --stop-evidence-file <path>");
    if (resolve(fromFile) === resolve(stopEvidenceFile))
      return fail("the stop evidence file must be separate from the previous key file");
    return {
      ok: true,
      command: {
        mode: "rewrap",
        fromFile,
        allProducersStopped: true,
        stopEvidenceFile,
        maintenance,
      },
    };
  }

  if (maintenance) return fail("--maintenance is only accepted by --rewrap-master-key");
  if (allProducersStopped || stopEvidenceFile !== undefined)
    return fail("stop acknowledgements are only accepted by --rewrap-master-key");
  if (fromFile !== undefined)
    return fail("--vault-set reads its value from --value-file, not --from-file");
  if (valueFile === undefined) return fail("--vault-set needs --value-file <path>");
  return {
    ok: true,
    command: { mode: "set", name: name!, valueFile, bindings, purpose, ifUnreadable, pending },
  };
}

export function trimOneTrailingNewline(raw: string): string {
  if (raw.endsWith("\r\n")) return raw.slice(0, -2);
  if (raw.endsWith("\n")) return raw.slice(0, -1);
  return raw;
}

export interface VaultCliOutcome {
  exitCode: 0 | 1 | 3;
  lines: string[];
}

export interface VersionProbe {
  version: number | null;
  readable: boolean;
  absent: boolean;
}

export interface Rebound {
  path: string;
  name: string;
  version: number;
}

export interface VaultOps {
  probeCurrentVersion(name: string): Promise<VersionProbe>;
  createVersion(name: string, value: string, purpose: string | null): Promise<{ version: number }>;
  prepareVersion(
    name: string,
    value: string,
    purpose: string | null,
    bindings: string[],
  ): Promise<{ version: number }>;
  rebind(path: string, name: string, version: number): Promise<Rebound>;
  servingReplicas(): Promise<string[]>;
  rewrap(
    previousKeyHex: string,
    acknowledgement: RewrapAcknowledgement & { maintenance: boolean },
  ): Promise<{ names: number; versions: number }>;
  preflight(): Promise<VaultCliOutcome>;
}

interface VaultCliDeps {
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
    value = trimOneTrailingNewline(read(command.valueFile));
  } catch (error) {
    return { exitCode: 1, lines: [`${command.valueFile}: cannot be read — ${messageOf(error)}`] };
  }
  if (value.length === 0) return { exitCode: 1, lines: [`${command.valueFile}: holds no value`] };

  if (command.pending) {
    try {
      const prepared = await ops.prepareVersion(
        command.name,
        value,
        command.purpose || DEFAULT_PURPOSE,
        command.bindings,
      );
      lines.push(
        `${command.name}: prepared version ${prepared.version}; waiting for approval in the Cockpit (Settings → Prepared changes)`,
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
  return { exitCode: failures.length ? 1 : 0, lines };
}

const MASTER_KEY_HEX = /^[0-9a-fA-F]{64}$/;

async function runRewrap(command: RewrapCommand, deps: VaultCliDeps): Promise<VaultCliOutcome> {
  const { ops } = deps;
  if (command.allProducersStopped !== true) {
    return { exitCode: 1, lines: ["rewrap: all producers stopped acknowledgement required"] };
  }
  if (
    !command.stopEvidenceFile ||
    resolve(command.fromFile) === resolve(command.stopEvidenceFile)
  ) {
    return { exitCode: 1, lines: ["rewrap: a separate stop evidence file is required"] };
  }
  let acknowledgement: RewrapAcknowledgement;
  try {
    const evidence = (deps.readFile ?? defaultReadFile)(command.stopEvidenceFile);
    acknowledgement = { all_producers_stopped: true, evidence };
    rewrapEvidenceDigest(acknowledgement);
  } catch {
    return {
      exitCode: 1,
      lines: ["rewrap: stop evidence is unreadable or invalid; provide 120 to 16000 characters"],
    };
  }

  if (!command.maintenance) {
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
    const report = await ops.rewrap(previous, {
      ...acknowledgement,
      maintenance: command.maintenance === true,
    });
    return {
      exitCode: 0,
      lines: [
        `rewrap: ${report.versions} version(s) across ${report.names} registry secret(s) re-encrypted under the target MASTER_KEY`,
      ],
    };
  } catch (error) {
    return { exitCode: 1, lines: [`rewrap: ${messageOf(error)}`] };
  }
}

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
