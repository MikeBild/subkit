import { createHash } from "node:crypto";

export function sha256HexOfText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CommandSpecForDigest {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  env_secret_names: readonly string[];
  cwd?: string | null | undefined;
}

export function commandSpecDigest(spec: CommandSpecForDigest): string {
  return sha256HexOfText(
    JSON.stringify({
      command: spec.command,
      args: [...spec.args],
      env: Object.keys(spec.env)
        .sort()
        .map((name) => [name, spec.env[name]]),
      env_secret_names: [...new Set(spec.env_secret_names)].sort(),
      cwd: spec.cwd ?? null,
    }),
  );
}
