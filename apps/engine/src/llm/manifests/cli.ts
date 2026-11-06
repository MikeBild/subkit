import data from "./cli-manifest.json" with { type: "json" };

interface CliFlagSpec {
  name: string;
  type: "string" | "boolean" | "number";
}

interface CliCommandSpec {
  flags: string[];
  positionals: string[];
  subcommands?: Record<string, CliCommandSpec>;
}

interface CliManifest {
  binary: string;
  aliases: string[];
  global_flags: CliFlagSpec[];
  subcommands: Record<string, CliCommandSpec>;
}

const MANIFEST = data as unknown as CliManifest;

export function getCliManifest(): CliManifest {
  return MANIFEST;
}

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

export function isGlobalFlag(name: string): boolean {
  return MANIFEST.global_flags.some((f) => f.name === name);
}
