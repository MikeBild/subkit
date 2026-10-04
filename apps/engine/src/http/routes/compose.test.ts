import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSE_YAML } from "./compose.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const onDisk = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

describe("GET /docker-compose.yml", () => {
  test("serves the repository file byte for byte", () => {
    expect(COMPOSE_YAML).toBe(onDisk);
  });

  test("carries the services a first run needs", () => {
    for (const service of ["engine", "postgres", "object-store", "object-store-init"]) {
      expect(COMPOSE_YAML).toContain(`  ${service}:`);
    }
  });

  test("pins the version this binary actually is", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(COMPOSE_YAML).toContain(`\${SUBKIT_IMAGE_TAG:-${pkg.version}}`);
  });

  test("pins the engine image rather than floating on latest", () => {
    expect(COMPOSE_YAML).toMatch(
      /image:\s*\$\{SUBKIT_IMAGE:-mikebild\/subkit:\$\{SUBKIT_IMAGE_TAG:-\d+\.\d+\.\d+\}\}/,
    );
  });

  test("needs exactly one operator-supplied value", () => {
    expect(COMPOSE_YAML).toContain("MASTER_KEY: ${MASTER_KEY:-}");
    const withoutDefaults = [...COMPOSE_YAML.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]);
    expect(withoutDefaults).toEqual([]);
  });

  test("references no private repository", () => {
    expect(COMPOSE_YAML).not.toContain("github.com");
  });
});
