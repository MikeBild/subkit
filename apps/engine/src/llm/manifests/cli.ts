// CliManifest — canonical structure of every `sk` subcommand and
// flag, used by the cli-ref output-guard scanner to reject invented
// flags in assistant-emitted bash blocks.
//
// The manifest is hand-curated JSON checked into the repo (see
// `cli-manifest.json`). NOTE: nothing currently asserts it stays consistent
// with `sk --help` — the contract test this comment used to name does not
// exist. Treat drift between the manifest and the real CLI as unguarded
// until such a test lands.

import data from "./cli-manifest.json" with { type: "json" };

export interface CliFlagSpec {
  name: string;
  type: "string" | "boolean" | "number";
}

export interface CliCommandSpec {
  flags: string[];
  positionals: string[];
  subcommands?: Record<string, CliCommandSpec>;
}

export interface CliManifest {
  binary: string;
  aliases: string[];
  global_flags: CliFlagSpec[];
  subcommands: Record<string, CliCommandSpec>;
}

const MANIFEST = data as unknown as CliManifest;

export function getCliManifest(): CliManifest {
  return MANIFEST;
}

/** Look up a (possibly nested) subcommand by path, e.g. `["apikeys", "create"]`. */
export function resolveSubcommand(path: string[]): CliCommandSpec | undefined {
  let current: Record<string, CliCommandSpec> | undefined = MANIFEST.subcommands;
  let spec: CliCommandSpec | undefined;
  for (const segment of path) {
    if (!current) return undefined;
    spec = current[segment];
    if (!spec) return undefined;
    current = spec.subcommands;
  }
  return spec;
}

/** Returns true if `name` is a recognised global flag (works on every subcommand). */
export function isGlobalFlag(name: string): boolean {
  return MANIFEST.global_flags.some((f) => f.name === name);
}
