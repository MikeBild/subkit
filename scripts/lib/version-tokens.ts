import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_SERVER_VERSION } from "../../apps/desktop/src/shared/server-contract.ts";
import { DESKTOP_MIN_VERSION_DEFAULT } from "../../apps/engine/src/config/schema.ts";

export type VersionTokens = Readonly<Record<string, string>>;

const TOKEN = /@@([A-Z][A-Z0-9_]*)@@/g;

export function renderVersionTokens(text: string, tokens: VersionTokens): string {
  return text.replace(TOKEN, (_, name: string) => {
    const value = tokens[name];
    if (value === undefined) throw new Error(`unknown version token @@${name}@@`);
    return value;
  });
}

export function versionTokens(input: {
  packageVersion: string;
  bunVersion: string;
}): VersionTokens {
  return {
    SUBKIT_VERSION: input.packageVersion,
    BUN_VERSION: input.bunVersion,
    DESKTOP_MIN_SERVER_VERSION: MIN_SERVER_VERSION,
    DESKTOP_MIN_APP_VERSION: DESKTOP_MIN_VERSION_DEFAULT,
  };
}

const ROOT = join(import.meta.dir, "..", "..");
let cached: VersionTokens | undefined;

export function repositoryVersionTokens(): VersionTokens {
  cached ??= versionTokens({
    packageVersion: (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
    ).version,
    bunVersion: readFileSync(join(ROOT, ".bun-version"), "utf8").trim(),
  });
  return cached;
}
